import { NextResponse } from "next/server";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";
import { verifyFirebaseIdTokenEmail } from "@/lib/verify-firebase-id-token";

export const runtime = "nodejs";

/**
 * POST { id_token } — ポータルと同じ Firebase 発行の ID トークンを検証し、day-app の2日Cookieを発行。
 * DELETE — ログアウト（Cookie破棄）。
 */
export async function POST(request: Request) {
  const { id_token } = (await request.json().catch(() => ({}))) as { id_token?: string };
  if (!id_token) return NextResponse.json({ ok: false, reason: "token_required" }, { status: 400 });

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) return NextResponse.json({ ok: false, reason: "firebase_not_configured" }, { status: 500 });

  const v = await verifyFirebaseIdTokenEmail(id_token, projectId);
  if (!v.ok) return NextResponse.json({ ok: false, reason: "invalid_token", code: v.code }, { status: 401 });

  const token = await signSession({ sub: v.uid, email: v.email });
  const res = NextResponse.json({ ok: true, email: v.email });
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
