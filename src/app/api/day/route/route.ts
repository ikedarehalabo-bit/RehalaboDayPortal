import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { travelMatrix, type LatLng } from "@/lib/day-google";
import { buildRoute, type RouteUser } from "@/lib/day-route";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/day/route { store, weekday, direction, session?, service_date? }
 * 指定店舗・曜日の送迎ルートを生成（各車×回転・要支援1便・NG・定員・走行均衡・店舗発着）。
 * direction: "pickup"(お迎え) / "dropoff"(お送り)
 * 名簿ソース: service_date の attendance があればそれ、無ければ members マスタ（既定曜日/時間帯）。
 * TODO(認証): 本番前に職員ロール認証を必須化する（現状は dev 用・認証なし・service-role）。
 */
const norm = (s: string) => (s ?? "").replace(/[　\s]+/g, "");

type MemberRow = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  is_yoshien: boolean;
  wheelchair: boolean;
  default_session: string | null;
  default_weekdays: string | null;
  needs_transport: boolean;
  active: boolean;
  geocoded: boolean;
};

export async function POST(request: Request) {
  const b = (await request.json().catch(() => ({}))) as {
    store?: string;
    weekday?: string;
    direction?: string;
    session?: string;
    service_date?: string;
  };
  const db = createServiceClient();

  // 店舗（stores に座標・デイ開始を統合済み）
  const { data: stores } = await db.from("stores").select("id,name,short_name,lat,lng,day_start_time");
  const store = (stores ?? []).find(
    (s) => norm(s.name) === norm(b.store ?? "") || norm(s.short_name ?? "") === norm(b.store ?? ""),
  ) as { id: string; name: string; lat: number | null; lng: number | null; day_start_time: string | null } | undefined;
  if (!store) return NextResponse.json({ ok: false, reason: "store_not_found" }, { status: 400 });
  if (!store.lat || !store.lng)
    return NextResponse.json({ ok: false, reason: "no_depot", hint: "店舗の座標（デポ）を先に設定してください。" }, { status: 400 });

  const weekday = b.weekday ?? "";
  const session = b.session ?? "";
  const direction = b.direction ?? "pickup";
  // 半日デイ：時間帯（午前/午後/終日）×方向で対象者を絞る
  const inSession = (s: string) => {
    if (!session) return true;
    if (session === "午前") return direction === "pickup" ? s === "午前" || s === "終日" : s === "午前";
    if (session === "午後") return direction === "pickup" ? s === "午後" : s === "午後" || s === "終日";
    return true;
  };

  const { data: allMembers } = await db
    .from("members")
    .select("id,name,lat,lng,is_yoshien,wheelchair,default_session,default_weekdays,needs_transport,active,geocoded")
    .eq("store_id", store.id);
  const members = (allMembers ?? []) as MemberRow[];

  // 名簿ソース：当日 attendance 優先、無ければ members（既定曜日）
  let roster: MemberRow[];
  let source: "attendance" | "members" = "members";
  if (b.service_date) {
    const { data: att } = await db
      .from("attendance")
      .select("member_id,session,planned_status")
      .eq("store_id", store.id)
      .eq("service_date", b.service_date)
      .in("planned_status", ["expected", "substitute"]);
    if (att && att.length) {
      source = "attendance";
      const sessById = new Map((att as { member_id: string; session: string }[]).map((a) => [a.member_id, a.session]));
      roster = members
        .filter((m) => sessById.has(m.id))
        .map((m) => ({ ...m, default_session: sessById.get(m.id) ?? m.default_session }));
    } else {
      roster = members.filter((m) => !weekday || (m.default_weekdays ?? "").split(",").includes(weekday));
    }
  } else {
    roster = members.filter((m) => !weekday || (m.default_weekdays ?? "").split(",").includes(weekday));
  }

  const users: RouteUser[] = roster
    .filter((m) => m.active && m.needs_transport && m.geocoded && m.lat != null && m.lng != null)
    .filter((m) => inSession(m.default_session ?? "終日"))
    .map((m) => ({ id: m.id, name: m.name, lat: m.lat!, lng: m.lng!, is_yoshien: m.is_yoshien, wheelchair: m.wheelchair }));

  if (users.length === 0)
    return NextResponse.json({
      ok: true,
      slots: [],
      unassigned: [],
      source,
      depot: { lat: store.lat, lng: store.lng },
      note: "対象者がいません（曜日・座標化・送迎要否をご確認ください）。",
    });

  // Google Routes API の1回上限（約25地点＝デポ＋利用者24）。超える場合は時間帯で絞ってもらう。
  if (users.length > 24)
    return NextResponse.json(
      {
        ok: false,
        reason: "too_many_points",
        count: users.length,
        hint: "対象が多すぎます（上限24名/回）。時間帯（午前/午後）で絞って生成してください。",
      },
      { status: 400 },
    );

  const { data: vehicles } = await db
    .from("vehicles")
    .select("id,name,seats,wheelchair_slots,rounds")
    .eq("store_id", store.id)
    .eq("active", true);
  if (!vehicles?.length)
    return NextResponse.json({ ok: false, reason: "no_vehicles", hint: "車両マスタを登録してください。" }, { status: 400 });

  const { data: ng } = await db.from("ng_pairs").select("member_a,member_b").eq("store_id", store.id);
  const ngPairs: [string, string][] = ((ng ?? []) as { member_a: string; member_b: string }[]).map((p) => [
    p.member_a,
    p.member_b,
  ]);

  // 行列：index0=デポ、1..n=users
  const points: LatLng[] = [{ lat: store.lat, lng: store.lng }, ...users.map((u) => ({ lat: u.lat, lng: u.lng }))];
  let matrix: number[][];
  try {
    matrix = await travelMatrix(points);
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "matrix_failed", detail: String(e) }, { status: 502 });
  }

  const result = buildRoute(users, vehicles, ngPairs, matrix);
  return NextResponse.json({
    ok: true,
    store: store.name,
    weekday,
    direction,
    session,
    source,
    start_time: store.day_start_time,
    depot: { lat: store.lat, lng: store.lng },
    ...result,
  });
}
