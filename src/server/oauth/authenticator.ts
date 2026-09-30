// Agent authentication by OAuth access token.
//
// A valid token proves who is calling. It does not by itself grant anything:
// the caller must also match an agent record that a person enrolled for this
// trip, that record must not be revoked, and the agent gets only the scopes
// present in BOTH its record and the token. Enrolling an agent (creating that
// record) is not built yet.

import "server-only";
import { SCOPES, type Scope } from "@/domain/model";
import type { AgentAuthenticator, AgentAuthResult } from "../agent-auth";
import type { OAuthIdentity, Store } from "../store/types";
import type { AccessTokenVerifier, VerifiedAccessToken } from "./token-verifier";

export interface OAuthAuthenticatorOptions {
  store: Store;
  verifier: AccessTokenVerifier;
  /** This server's canonical resource URI. Must equal the audience the verifier checks. */
  resource: string;
  /** Issuer identifier of the one authorization server this app trusts. */
  issuer: string;
}

/**
 * The identity an agent record is keyed on. The client application is part of
 * it, so the same person connecting through two different assistants is two
 * separately revocable agents.
 */
export function agentIdentity(token: VerifiedAccessToken): OAuthIdentity {
  return {
    issuer: token.issuer,
    subject: token.clientId ? `${token.clientId}|${token.subject}` : token.subject,
  };
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value);

export function createOAuthAgentAuthenticator(options: OAuthAuthenticatorOptions): AgentAuthenticator {
  return {
    mode: "oauth",
    protectedResource: {
      resource: options.resource,
      authorizationServers: [options.issuer],
      scopesSupported: SCOPES,
    },
    async authenticate(request, tripId): Promise<AgentAuthResult> {
      const token = bearerToken(request);
      if (!token) return { ok: false, reason: "invalid" };
      const verified = await options.verifier.verify(token);
      if (!verified) return { ok: false, reason: "invalid" };

      const agent = await options.store.transaction((tx) => tx.getAgentByOAuthIdentity(agentIdentity(verified)));
      if (!agent || agent.revokedAt !== null) return { ok: false, reason: "insufficient" };
      const grant = agent.grants.find((candidate) => candidate.tripId === tripId);
      if (!grant) return { ok: false, reason: "insufficient" };

      // The token can narrow what the agent's record allows. It can never widen it.
      const tokenScopes = new Set(verified.scopes.filter(isScope));
      const scopes = grant.scopes.filter((scope) => tokenScopes.has(scope));
      if (scopes.length === 0) return { ok: false, reason: "insufficient" };

      return { ok: true, principal: { type: "agent", id: agent.id, label: agent.name, tripId, scopes } };
    },
  };
}
