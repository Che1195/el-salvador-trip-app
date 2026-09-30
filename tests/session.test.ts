import { describe, expect, it } from "vitest";
import { clearedSessionCookie, readCookie, sessionCookie, signSession, verifySessionToken, type SessionClaims } from "@/server/session";

const secret = Buffer.from("unit-test-signing-key-not-a-real-secret");
const NOW = 1_900_000_000_000;
const claims: SessionClaims = { sid: "s1", tid: "trip_1", iat: NOW / 1000, exp: NOW / 1000 + 60, pv: "abc" };

describe("session tokens", () => {
  it("round-trips valid claims", () => {
    expect(verifySessionToken(signSession(claims, secret), secret, NOW)).toEqual(claims);
  });

  it("rejects a token at or past its expiry", () => {
    const token = signSession(claims, secret);
    expect(verifySessionToken(token, secret, NOW + 59_999)).not.toBeNull();
    expect(verifySessionToken(token, secret, NOW + 60_000)).toBeNull();
    expect(verifySessionToken(token, secret, NOW + 10_000_000)).toBeNull();
  });

  it("rejects any change to the payload or signature, and other keys", () => {
    const token = signSession(claims, secret);
    const [version, payload, signature] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ ...claims, tid: "trip_other" })).toString("base64url");
    expect(verifySessionToken(`${version}.${edited}.${signature}`, secret, NOW)).toBeNull();
    expect(verifySessionToken(`${version}.${payload}.${signature.slice(0, -1)}`, secret, NOW)).toBeNull();
    expect(verifySessionToken(`${version}.${payload}.`, secret, NOW)).toBeNull();
    expect(verifySessionToken(`v2.${payload}.${signature}`, secret, NOW)).toBeNull();
    expect(verifySessionToken(token, Buffer.from("another-key-entirely-for-this-test"), NOW)).toBeNull();
    expect(verifySessionToken(`${token}.extra`, secret, NOW)).toBeNull();
    expect(verifySessionToken("x".repeat(5000), secret, NOW)).toBeNull();
  });

  it("rejects well-signed payloads with the wrong shape", () => {
    const bad = signSession({ ...claims, exp: "soon" } as unknown as SessionClaims, secret);
    expect(verifySessionToken(bad, secret, NOW)).toBeNull();
  });
});

describe("session cookie", () => {
  it("is HttpOnly and SameSite, and Secure when configured", () => {
    expect(sessionCookie({ name: "trip_session", secure: false }, "t", 10)).toBe("trip_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=10");
    expect(sessionCookie({ name: "__Host-trip_session", secure: true }, "t", 10)).toBe("__Host-trip_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure");
    expect(clearedSessionCookie({ name: "__Host-trip_session", secure: true })).toBe("__Host-trip_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("reads one cookie by exact name", () => {
    expect(readCookie("a=1; trip_session=abc.def; b=2", "trip_session")).toBe("abc.def");
    expect(readCookie("xtrip_session=no", "trip_session")).toBeNull();
    expect(readCookie(null, "trip_session")).toBeNull();
  });
});
