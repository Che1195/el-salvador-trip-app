// Server-side check of a web session. Pages and every private API route go
// through `authenticateSessionToken`; there is no client-side gate.

import "server-only";
import type { AuthConfig } from "./config";
import type { Deps } from "./deps";
import { DomainError } from "./errors";
import { sha256Hex } from "./hash";
import { readCookie, verifySessionToken } from "./session";
import type { SessionRecord, Store } from "./store/types";

export interface WebPrincipal {
  type: "web";
  id: string;
  label: string;
  tripId: string;
}

export interface WebSession {
  principal: WebPrincipal;
  session: SessionRecord;
  store: Store;
  auth: Extract<AuthConfig, { ready: true }>;
}

/** Actor id for the activity log. Derived by hash so it reveals nothing of the session id. */
export function webPrincipalId(sessionId: string): string {
  return `web_${sha256Hex(sessionId).slice(0, 12)}`;
}

/**
 * A session is valid only if all of these hold: the token carries our
 * signature and has not expired; it was issued under the current password;
 * it is for this trip; and the server-side record exists, is not revoked, has
 * not expired, and predates no "sign out everywhere".
 */
export async function authenticateSessionToken(token: string | null, deps: Deps): Promise<WebSession> {
  const { auth, tripId } = deps.config;
  const store = deps.store;
  if (!auth.ready || !store) {
    throw new DomainError("unavailable", "This app is not fully set up yet.");
  }
  const denied = new DomainError("unauthenticated", "Sign in to continue.");
  if (!token) throw denied;

  const now = deps.clock();
  const claims = verifySessionToken(token, auth.sessionSecret, now.getTime());
  if (!claims || claims.pv !== auth.passwordVersion || claims.tid !== tripId) throw denied;

  const { session, epoch } = await store.transaction(async (tx) => ({
    session: await tx.getSession(claims.sid),
    epoch: await tx.getSessionEpoch(tripId),
  }));
  if (
    !session ||
    session.tripId !== tripId ||
    session.revokedAt !== null ||
    session.expiresAt <= now.toISOString() ||
    session.epoch !== epoch
  ) {
    throw denied;
  }

  return {
    principal: { type: "web", id: webPrincipalId(session.id), label: session.label, tripId },
    session,
    store,
    auth,
  };
}

export function requireWebSession(request: Request, deps: Deps): Promise<WebSession> {
  const name = deps.config.auth.ready ? deps.config.auth.cookie.name : null;
  const token = name ? readCookie(request.headers.get("cookie"), name) : null;
  return authenticateSessionToken(token, deps);
}
