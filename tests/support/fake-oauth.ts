// A stand-in OAuth authorization server for tests. It generates its own
// throwaway signing keys in memory on every run and mints access tokens with
// them. Nothing here is a real provider, client, key or token, and nothing
// leaves the test process.

import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const FAKE_ISSUER = "https://auth.fake-provider.test";
export const FAKE_RESOURCE = "http://localhost:3000/api/mcp";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface FakeProvider {
  /** The published verification keys, as a verifier would fetch them. */
  keys: JWTVerifyGetKey;
  publicJwk: JWK;
  /** Mints a token. Anything in `claims` overrides the defaults; `undefined` removes a claim. */
  issue(claims?: Record<string, unknown>, options?: { header?: Record<string, unknown>; key?: SigningKey; alg?: string }): Promise<string>;
  /** A key the provider never published. */
  strangerKey: SigningKey;
}

export async function createFakeProvider(now: () => Date): Promise<FakeProvider> {
  const published = await generateKeyPair("ES256", { extractable: true });
  const stranger = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(published.publicKey)), kid: "fake-key-1", alg: "ES256", use: "sig" };

  return {
    keys: createLocalJWKSet({ keys: [publicJwk] }),
    publicJwk,
    strangerKey: stranger.privateKey,
    async issue(claims = {}, options = {}) {
      const seconds = Math.floor(now().getTime() / 1000);
      const payload: JWTPayload = {
        iss: FAKE_ISSUER,
        aud: FAKE_RESOURCE,
        sub: "user-1",
        client_id: "client-1",
        scope: "trip:read trip:write packing:read packing:write",
        iat: seconds,
        exp: seconds + 300,
        ...claims,
      };
      for (const [name, value] of Object.entries(payload)) {
        if (value === undefined) delete payload[name];
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: options.alg ?? "ES256", kid: "fake-key-1", typ: "at+jwt", ...options.header })
        .sign(options.key ?? published.privateKey);
    },
  };
}

/** Builds an unsigned or arbitrarily "signed" token by hand, for attack cases. */
export function handmadeToken(header: Record<string, unknown>, payload: Record<string, unknown>, signature = ""): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.${signature}`;
}
