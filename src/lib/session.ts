import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * day-app 独自のセッション（ポータル認証で本人確認したあと発行する2日Cookie）。
 * 署名は SESSION_SECRET（HS256）。middleware(edge) と API(node) の両方から使う。
 */
export const SESSION_COOKIE = "rdp_session";
const SESSION_TTL_SEC = 60 * 60 * 48; // 2日

const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET || "");

export async function signSession(payload: { sub: string; email?: string }): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_MAX_AGE = SESSION_TTL_SEC;
