import { NextResponse } from "next/server";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";

export const runtime = "nodejs";

/**
 * POST { access_token } — ポータル(Supabase)発行のトークンを検証し、day-app の2日Cookieを発行。
 * DELETE — ログアウト（Cookie破棄）。
 */
export async function POST(request: Request) {
  const { access_token } = (await request.json().catch(() => ({}))) as { access_token?: string };
  if (!access_token) return NextResponse.json({ ok: false, reason: "token_required" }, { status: 400 });

  const url = process.env.NEXT_PUBLIC_PORTAL_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_PORTAL_SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.json({ ok: false, reason: "portal_auth_not_configured" }, { status: 500 });

  // ポータルのSupabaseでトークンを検証（有効なユーザーが返れば本物）
  const r = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${access_token}`, apikey: anon },
  });
  if (!r.ok) return NextResponse.json({ ok: false, reason: "invalid_portal_token" }, { status: 401 });
  const user = (await r.json()) as { id: string; email?: string };
  if (!user?.id) return NextResponse.json({ ok: false, reason: "invalid_portal_token" }, { status: 401 });

  const token = await signSession({ sub: user.id, email: user.email });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
