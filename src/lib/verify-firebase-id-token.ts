import { importX509, jwtVerify, type JWTPayload } from "jose";

export type VerifyFirebaseTokenCode = "verify_failed" | "no_email";

/**
 * Firebase Auth の ID トークンは **Google OAuth2 の oauth2/v3/certs ではなく**、
 * securetoken@system.gserviceaccount.com の X.509 で署名される。
 * google-auth-library の verifyIdToken は前者しか使わないため検証に失敗する。
 * @see https://firebase.google.com/docs/auth/admin/verify-id-tokens
 */
const SECURETOKEN_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

type CertsCache = { map: Record<string, string>; expiresAt: number };
let certsCache: CertsCache | null = null;

async function getSecureTokenCertificates(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certsCache && now < certsCache.expiresAt) {
    return certsCache.map;
  }
  const res = await fetch(SECURETOKEN_CERTS_URL);
  if (!res.ok) {
    throw new Error(`securetoken certs HTTP ${res.status}`);
  }
  const map = (await res.json()) as Record<string, string>;
  const cc = res.headers.get("cache-control");
  let ttlMs = 60 * 60 * 1000;
  const m = cc?.match(/max-age=(\d+)/);
  if (m) {
    ttlMs = Math.min(parseInt(m[1], 10) * 1000, 24 * 60 * 60 * 1000);
  }
  certsCache = { map, expiresAt: now + ttlMs };
  return map;
}

function decodePayloadDebug(idToken: string): { iss?: unknown; aud?: unknown } | null {
  try {
    const parts = idToken.split(".");
    if (!parts[1]) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      iss?: unknown;
      aud?: unknown;
    };
  } catch {
    return null;
  }
}

async function verifyFirebaseIdTokenOnce(
  idToken: string,
  projectId: string,
  issuer: string
): Promise<{ payload: JWTPayload }> {
  const keys = await getSecureTokenCertificates();
  return jwtVerify(
    idToken,
    async (protectedHeader) => {
      const kid = protectedHeader.kid;
      if (!kid) {
        throw new Error("JWT header missing kid");
      }
      const pem = keys[kid];
      if (!pem) {
        throw new Error(`No x509 for kid=${kid}`);
      }
      return importX509(pem, "RS256");
    },
    {
      issuer,
      audience: projectId,
      algorithms: ["RS256"],
      clockTolerance: 120,
    }
  );
}

/**
 * Firebase Auth の ID トークンを検証し、メールを返す（サービスアカウント鍵不要）。
 */
export async function verifyFirebaseIdTokenEmail(
  idToken: string,
  projectId: string
): Promise<
  | { ok: true; email: string; emailVerified: boolean; uid: string }
  | { ok: false; code: VerifyFirebaseTokenCode }
> {
  const issuer = `https://securetoken.google.com/${projectId}`;
  try {
    let payload: JWTPayload;
    try {
      ({ payload } = await verifyFirebaseIdTokenOnce(idToken, projectId, issuer));
    } catch (first) {
      const msg = first instanceof Error ? first.message : "";
      if (msg.includes("No x509 for kid")) {
        certsCache = null;
        ({ payload } = await verifyFirebaseIdTokenOnce(idToken, projectId, issuer));
      } else {
        throw first;
      }
    }

    const email = payload.email;
    if (typeof email !== "string" || !email) {
      return { ok: false, code: "no_email" };
    }
    const uidRaw = payload.sub;
    if (typeof uidRaw !== "string" || !uidRaw) {
      return { ok: false, code: "verify_failed" };
    }
    const emailVerified = payload.email_verified === true;
    return { ok: true, email, emailVerified, uid: uidRaw };
  } catch (e) {
    console.error("[verifyFirebaseIdTokenEmail] jwtVerify failed:", e);
    const dbg = decodePayloadDebug(idToken);
    console.error(
      "[verifyFirebaseIdTokenEmail] token iss:",
      dbg?.iss,
      "| aud:",
      dbg?.aud,
      "| expected issuer:",
      issuer,
      "| expected audience:",
      projectId
    );
    return { ok: false, code: "verify_failed" };
  }
}
