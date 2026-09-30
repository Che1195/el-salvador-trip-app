// Validation of OAuth 2.1 access tokens presented to the MCP endpoint.
//
// This app would be an OAuth "resource server": it never issues tokens, it
// only checks tokens issued by a separate authorization server. Per the MCP
// authorization specification, a token is accepted only if it was issued for
// this server specifically (audience), by the expected issuer, is unexpired,
// and carries a valid signature from that issuer's published keys.
//
// Status: exercised only against a fake provider in tests/oauth.test.ts. No
// real authorization server has been connected.

import "server-only";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export interface VerifiedAccessToken {
  issuer: string;
  /** The user the token was issued for. */
  subject: string;
  /** The client application the token was issued to, when the issuer says. */
  clientId: string | null;
  scopes: string[];
  /** Seconds since the epoch. */
  expiresAt: number;
}

export interface AccessTokenVerifier {
  /** The token's claims if every check passes, otherwise null. Never throws for a bad token. */
  verify(token: string): Promise<VerifiedAccessToken | null>;
}

// Signature algorithms with a public verification key. Symmetric algorithms
// (HS256 and friends) and "none" are never accepted: with them, anyone who
// knows the public key, or no one at all, could mint a token.
const ASYMMETRIC_ALGORITHMS = ["RS256", "PS256", "ES256", "ES384", "EdDSA"];
const ACCEPTED_TYPES = new Set(["at+jwt", "jwt"]);
const MAX_TOKEN_LENGTH = 8192;

export interface JwtVerifierOptions {
  /** Exact issuer identifier of the authorization server. */
  issuer: string;
  /** This server's canonical resource URI, for example https://host/api/mcp. */
  audience: string;
  /** Resolves the issuer's signing keys. A remote JWKS in production, a local one in tests. */
  keys: JWTVerifyGetKey;
  clock: () => Date;
}

function parseScopes(claims: Record<string, unknown>): string[] {
  if (typeof claims.scope === "string") return claims.scope.split(" ").filter(Boolean);
  if (Array.isArray(claims.scp)) return claims.scp.filter((value): value is string => typeof value === "string");
  return [];
}

export function createJwtAccessTokenVerifier(options: JwtVerifierOptions): AccessTokenVerifier {
  return {
    async verify(token) {
      if (token.length > MAX_TOKEN_LENGTH) return null;
      try {
        const { payload, protectedHeader } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ASYMMETRIC_ALGORITHMS,
          currentDate: options.clock(),
          clockTolerance: 5,
          requiredClaims: ["iss", "aud", "exp", "sub"],
        });
        const type = typeof protectedHeader.typ === "string" ? protectedHeader.typ.toLowerCase() : "jwt";
        if (!ACCEPTED_TYPES.has(type.replace(/^application\//, ""))) return null;
        if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.exp !== "number") return null;
        const clientId = payload.client_id ?? payload.azp;
        return {
          issuer: options.issuer,
          subject: payload.sub,
          clientId: typeof clientId === "string" && clientId !== "" ? clientId : null,
          scopes: parseScopes(payload),
          expiresAt: payload.exp,
        };
      } catch {
        // Bad signature, wrong audience, expired, malformed: all the same to the caller.
        return null;
      }
    },
  };
}
