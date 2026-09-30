// Signed session tokens and the cookie that carries them. A valid signature
// is necessary but not sufficient: web-auth.ts also checks the server-side
// session record, which is what makes sign-out and revocation real.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  /** Session id: the key of the server-side session record. */
  sid: string;
  /** Trip the session grants access to. */
  tid: string;
  /** Issued at and expiry, in seconds since the epoch. */
  iat: number;
  exp: number;
  /** Fingerprint of the password hash in force when the session began. */
  pv: string;
}

const VERSION = "v1";
const MAX_TOKEN_LENGTH = 1024;

function sign(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(`${VERSION}.${payload}`).digest();
}

export function signSession(claims: SessionClaims, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(payload, secret).toString("base64url")}`;
}

/** Returns the claims only if the signature is ours and the token has not expired. */
export function verifySessionToken(token: string, secret: Buffer, nowMs: number): SessionClaims | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, signature] = parts;

  const expected = sign(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { sid, tid, iat, exp, pv } = claims as Record<string, unknown>;
  if (typeof sid !== "string" || typeof tid !== "string" || typeof pv !== "string") return null;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (exp * 1000 <= nowMs) return null;
  return { sid, tid, iat, exp, pv };
}

export interface CookieSettings {
  name: string;
  secure: boolean;
}

function cookieAttributes(settings: CookieSettings, maxAgeSeconds: number): string {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (settings.secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookie(settings: CookieSettings, token: string, maxAgeSeconds: number): string {
  return `${settings.name}=${token}; ${cookieAttributes(settings, maxAgeSeconds)}`;
}

export function clearedSessionCookie(settings: CookieSettings): string {
  return `${settings.name}=; ${cookieAttributes(settings, 0)}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
