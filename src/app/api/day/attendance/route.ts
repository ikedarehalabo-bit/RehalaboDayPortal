import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

/**
 * 出欠台帳の読込・保存。
 * GET  /api/day/attendance?store=<name>&date=<YYYY-MM-DD>
 *      → その日の対象者（曜日一致）＋既存出欠状態＋振替、振替追加用の others。
 * POST /api/day/attendance { store, date, entries: [{member_id, planned_status, session}] }
 *      → attendance に upsert（日付×利用者ユニーク）＋監査ログ。
 * TODO(認証): 職員ロール必須化。family_locked の競合制御（家族入力導入時）。
 */
const JP_WD = ["日", "月", "火", "水", "木", "金", "土"];
const norm = (s: string) => (s ?? "").replace(/[　\s]+/g, "");
const weekdayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return JP_WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

async function resolveStore(db: ReturnType<typeof createServiceClient>, name: string) {
  const { data: stores } = await db.from("stores").select("id,tenant_id,name,short_name");
  return (stores ?? []).find(
    (s) => norm(s.name) === norm(name) || norm(s.short_name ?? "") === norm(name),
  ) as { id: string; tenant_id: string; name: string } | undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storeName = url.searchParams.get("store") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!storeName || !date) return NextResponse.json({ ok: false, reason: "store/date required" }, { status: 400 });

  const db = createServiceClient();
  const store = await resolveStore(db, storeName);
  if (!store) return NextResponse.json({ ok: false, reason: "store_not_found" }, { status: 400 });

  const wd = weekdayOf(date);
  const { data: membersRaw } = await db
    .from("members")
    .select("id,name,default_weekdays,default_session,is_yoshien,wheelchair,needs_transport,active")
    .eq("store_id", store.id)
    .eq("active", true);
  const members = membersRaw ?? [];
  const isCandidate = (m: { default_weekdays: string | null }) =>
    (m.default_weekdays ?? "").split(",").map((x: string) => x.trim()).includes(wd);
  const candidates = members.filter(isCandidate);
  const candIds = new Set(candidates.map((m) => m.id));

  const { data: attRaw } = await db
    .from("attendance")
    .select("member_id,planned_status,session,family_locked")
    .eq("store_id", store.id)
    .eq("service_date", date);
  const attById = new Map((attRaw ?? []).map((a) => [a.member_id, a]));

  const mkRow = (m: (typeof members)[number], planned: string) => {
    const a = attById.get(m.id);
    return {
      member_id: m.id,
      name: m.name,
      is_yoshien: m.is_yoshien,
      needs_transport: m.needs_transport,
      planned_status: a?.planned_status ?? planned,
      session: a?.session ?? m.default_session ?? "終日",
      family_locked: a?.family_locked ?? false,
      saved: !!a,
    };
  };

  const roster = candidates.map((m) => mkRow(m, "expected"));
  // 振替（候補外だが attendance に substitute で存在）
  const subs = (attRaw ?? []).filter((a) => a.planned_status === "substitute" && !candIds.has(a.member_id));
  for (const a of subs) {
    const m = members.find((x) => x.id === a.member_id);
    if (m) roster.push(mkRow(m, "substitute"));
  }
  // 振替追加候補（同店舗のアクティブ利用者・候補外）
  const others = members.filter((m) => !candIds.has(m.id)).map((m) => ({ member_id: m.id, name: m.name }));

  return NextResponse.json({ ok: true, store: store.name, date, weekday: wd, roster, others });
}

export async function POST(request: Request) {
  const b = (await request.json().catch(() => ({}))) as {
    store?: string;
    date?: string;
    entries?: { member_id: string; planned_status: string; session?: string }[];
  };
  if (!b.store || !b.date || !Array.isArray(b.entries))
    return NextResponse.json({ ok: false, reason: "store/date/entries required" }, { status: 400 });

  const db = createServiceClient();
  const store = await resolveStore(db, b.store);
  if (!store) return NextResponse.json({ ok: false, reason: "store_not_found" }, { status: 400 });

  const now = new Date().toISOString();
  const rows = b.entries.map((e) => ({
    tenant_id: store.tenant_id,
    store_id: store.id,
    member_id: e.member_id,
    service_date: b.date,
    session: e.session ?? "終日",
    planned_status: e.planned_status,
    source: "staff",
    actor_role: "staff",
    decided_at: now,
  }));

  const { data: saved, error } = await db
    .from("attendance")
    .upsert(rows, { onConflict: "member_id,service_date" })
    .select("id,member_id,planned_status");
  if (error) return NextResponse.json({ ok: false, reason: "save_failed", detail: error.message }, { status: 500 });

  // 監査ログ（簡易：保存時の値を記録）
  const logs = (saved ?? []).map((r) => ({
    tenant_id: store.tenant_id,
    attendance_id: r.id,
    actor_role: "staff",
    source: "staff",
    field: "planned_status",
    new_value: r.planned_status,
  }));
  if (logs.length) await db.from("attendance_log").insert(logs);

  return NextResponse.json({ ok: true, saved: saved?.length ?? 0 });
}
