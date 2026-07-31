import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { notifyMember } from "@/lib/push";

export const runtime = "nodejs";

/**
 * 乗降通知の記録。
 * GET  ?store=&date= → その日の記録一覧 [{member_id, event_type}]
 * POST { store, date, member_id, event_type, recorded } — recorded=true:記録/ false:取消。
 *      記録時に家族へ通知（notifyMember＝受け手が居れば送信・居なければ基盤のみ）。
 * event_type: picked_up(お迎え乗車) / dropped_off(自宅お送り)
 */
const norm = (s: string) => (s ?? "").replace(/[　\s]+/g, "");
const LABEL: Record<string, string> = { picked_up: "お迎えに伺いました", dropped_off: "ご自宅にお送りしました" };

async function resolveStore(db: ReturnType<typeof createServiceClient>, name: string) {
  const { data: stores } = await db.from("stores").select("id,tenant_id,name,short_name");
  return (stores ?? []).find(
    (s) => norm(s.name) === norm(name) || norm(s.short_name ?? "") === norm(name),
  ) as { id: string; tenant_id: string; name: string } | undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = url.searchParams.get("store") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!store || !date) return NextResponse.json({ ok: false, reason: "store/date required" }, { status: 400 });
  const db = createServiceClient();
  const st = await resolveStore(db, store);
  if (!st) return NextResponse.json({ ok: false, reason: "store_not_found" }, { status: 400 });
  const { data } = await db
    .from("ride_events")
    .select("member_id,event_type,occurred_at")
    .eq("store_id", st.id)
    .eq("service_date", date);
  return NextResponse.json({ ok: true, events: data ?? [] });
}

export async function POST(request: Request) {
  const b = (await request.json().catch(() => ({}))) as {
    store?: string;
    date?: string;
    member_id?: string;
    event_type?: string;
    recorded?: boolean;
  };
  if (!b.store || !b.date || !b.member_id || !b.event_type)
    return NextResponse.json({ ok: false, reason: "params required" }, { status: 400 });
  if (b.event_type !== "picked_up" && b.event_type !== "dropped_off")
    return NextResponse.json({ ok: false, reason: "bad_event_type" }, { status: 400 });

  const db = createServiceClient();
  const st = await resolveStore(db, b.store);
  if (!st) return NextResponse.json({ ok: false, reason: "store_not_found" }, { status: 400 });

  if (b.recorded === false) {
    await db
      .from("ride_events")
      .delete()
      .eq("store_id", st.id)
      .eq("service_date", b.date)
      .eq("member_id", b.member_id)
      .eq("event_type", b.event_type);
    return NextResponse.json({ ok: true, recorded: false });
  }

  // 既存があれば二重記録しない
  const { data: existing } = await db
    .from("ride_events")
    .select("id")
    .eq("store_id", st.id)
    .eq("service_date", b.date)
    .eq("member_id", b.member_id)
    .eq("event_type", b.event_type)
    .limit(1);

  if (!existing?.length) {
    await db.from("ride_events").insert({
      tenant_id: st.tenant_id,
      store_id: st.id,
      member_id: b.member_id,
      service_date: b.date,
      event_type: b.event_type,
      notified: false,
    });
  }

  // 家族へ通知（受け手が居れば送信・居なければ基盤のみ稼働）
  const sent = await notifyMember(db, {
    memberId: b.member_id,
    tenantId: st.tenant_id,
    kind: "ride",
    title: st.name,
    body: LABEL[b.event_type],
    relatedId: undefined,
  });

  return NextResponse.json({ ok: true, recorded: true, notified: sent });
}
