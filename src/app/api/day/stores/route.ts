import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

/** GET /api/day/stores → デイ店舗一覧（タブ用）。 */
export async function GET() {
  const db = createServiceClient();
  const { data } = await db
    .from("stores")
    .select("name,short_name,pools(name)")
    .eq("kind", "dayservice")
    .order("name");
  const stores = ((data ?? []) as unknown[]).map((row) => {
    const s = row as { name: string; short_name: string | null; pools: { name: string } | { name: string }[] | null };
    const pool = Array.isArray(s.pools) ? s.pools[0]?.name ?? null : s.pools?.name ?? null;
    return { name: s.name, short_name: s.short_name, pool };
  });
  return NextResponse.json({ ok: true, stores });
}
