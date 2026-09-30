// Who an agent is, and what it may do, is decided here and nowhere else.
//
// An agent never uses the shared website password. Each agent has its own
// record with its own scopes, and revoking that one record cuts it off on its
// next request. The acting identity always comes from the verified
// credential, never from anything in the request body.
//
// Status: deployed environments always use the disabled authenticator, so
// every remote request gets 503. The local fixture authenticator runs in
// local development only. An OAuth authenticator exists in ./oauth and is
// tested against a fake provider, but nothing constructs it outside tests
// until a real integration has been verified. See docs/mcp.md.

import "server-only";
import type { Scope } from "@/domain/model";
import type { AppConfig } from "./config";
import { sha256Hex } from "./hash";
import type { Store } from "./store/types";

export interface AgentPrincipal {
  type: "agent";
  id: string;
  label: string;
  tripId: string;
  scopes: readonly Scope[];
}

export type AgentAuthResult =
  | { ok: true; principal: AgentPrincipal }
  /**
   * not_configured: agent access is off (503).
   * invalid: no credential, or one that does not verify (401).
   * insufficient: the credential is genuine but grants nothing here (403).
   */
  | { ok: false; reason: "not_configured" | "invalid" | "insufficient" };

/** What this server publishes about itself as an OAuth protected resource. */
export interface ProtectedResourceInfo {
  /** Canonical URI of the MCP endpoint. Tokens must name it as their audience. */
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported: readonly Scope[];
}

export interface AgentAuthenticator {
  readonly mode: "disabled" | "local-fixture" | "oauth";
  /** Present only when agents authenticate with OAuth access tokens. */
  readonly protectedResource?: ProtectedResourceInfo;
  authenticate(request: Request, tripId: string): Promise<AgentAuthResult>;
}

export const disabledAgentAuthenticator: AgentAuthenticator = {
  mode: "disabled",
  async authenticate() {
    return { ok: false, reason: "not_configured" };
  },
};

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Looks an opaque bearer credential up by its hash. Used for the local
 * development fixture and in tests; it refuses to be built anywhere else.
 */
export function createFixtureAgentAuthenticator(
  store: Store,
  deployment: AppConfig["deployment"],
): AgentAuthenticator {
  if (deployment !== "local") {
    throw new Error("The fixture agent authenticator only runs in local development.");
  }
  return {
    mode: "local-fixture",
    async authenticate(request, tripId) {
      const token = bearerToken(request);
      if (!token) return { ok: false, reason: "invalid" };
      const agent = await store.transaction((tx) => tx.getAgentByCredentialHash(sha256Hex(token)));
      if (!agent || agent.revokedAt !== null) return { ok: false, reason: "invalid" };
      const grant = agent.grants.find((candidate) => candidate.tripId === tripId);
      if (!grant || grant.scopes.length === 0) return { ok: false, reason: "invalid" };
      return {
        ok: true,
        principal: { type: "agent", id: agent.id, label: agent.name, tripId, scopes: grant.scopes },
      };
    },
  };
}
