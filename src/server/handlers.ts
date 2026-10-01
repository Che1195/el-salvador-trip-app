// Request handlers for the web API. Each takes the request and the server
// dependencies and returns a response, so the route files stay one line long
// and tests can call these directly.
//
// Every handler that returns or changes trip data calls `requireWebSession`
// first. tests/routes.test.ts fails if a route file exists that is not
// covered there.

import "server-only";
import { z } from "zod";
import { SESSION_TTL_SECONDS } from "./config";
import type { Deps } from "./deps";
import { DomainError } from "./errors";
import { newId, randomToken } from "./hash";
import {
  assertTrustedMutation,
  clientKey,
  jsonResponse,
  readJsonBody,
  toErrorResponse,
} from "./http";
import { executeOperation, getTripSnapshot, type OpContext } from "./operations";
import { verifyPassword } from "./password";
import { clearedSessionCookie, sessionCookie, signSession } from "./session";
import type { Store } from "./store/types";
import { requireWebSession, webPrincipalId, type WebSession } from "./web-auth";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_PER_ADDRESS = 8;
const LOGIN_LIMIT_TOTAL = 100;
const OPS_LIMIT_PER_MINUTE = 240;
const MAX_LOGIN_BODY_BYTES = 2 * 1024;
const MAX_OPS_BODY_BYTES = 32 * 1024;

async function enforceRateLimit(
  store: Store,
  key: string,
  limit: number,
  windowMs: number,
  now: Date,
): Promise<void> {
  const hit = await store.hitRateLimit(key, limit, windowMs, now);
  if (!hit.allowed) {
    throw new DomainError("rate_limited", "Too many attempts. Try again later.", {
      retryAfterSeconds: hit.retryAfterSeconds,
    });
  }
}

function contextFor(session: WebSession, deps: Deps): OpContext {
  return {
    principal: session.principal,
    tripId: deps.config.tripId,
    store: session.store,
    now: deps.clock(),
  };
}

async function auditAuthEvent(
  store: Store,
  deps: Deps,
  event: { op: string; outcome: string; actorId: string; actorLabel: string },
): Promise<void> {
  await store.transaction((tx) =>
    tx.appendAudit({
      tripId: deps.config.tripId,
      id: newId("aud"),
      at: deps.clock().toISOString(),
      actorType: "web",
      actorId: event.actorId,
      actorLabel: event.actorLabel,
      op: event.op,
      kind: null,
      entityId: null,
      batchId: null,
      changeId: null,
      outcome: event.outcome,
    }),
  );
}

const loginSchema = z.strictObject({
  password: z.string().min(1).max(200),
  label: z
    .string()
    .trim()
    .max(40)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
    .optional(),
});

export async function handleLogin(request: Request, deps: Deps): Promise<Response> {
  try {
    assertTrustedMutation(request, deps.config);
    const { auth, tripId } = deps.config;
    const store = deps.store;
    if (!auth.ready || !store) {
      throw new DomainError("unavailable", "Sign-in is not set up yet.");
    }
    const now = deps.clock();
    // Count the attempt before doing any work, so guessing is slow and cheap to refuse.
    await enforceRateLimit(store, `login:address:${clientKey(request)}`, LOGIN_LIMIT_PER_ADDRESS, LOGIN_WINDOW_MS, now);
    await enforceRateLimit(store, "login:all", LOGIN_LIMIT_TOTAL, LOGIN_WINDOW_MS, now);

    const parsed = loginSchema.safeParse(await readJsonBody(request, MAX_LOGIN_BODY_BYTES));
    if (!parsed.success) throw new DomainError("validation_failed", "Enter the trip password.");

    if (!(await verifyPassword(parsed.data.password, auth.passwordHash))) {
      await auditAuthEvent(store, deps, {
        op: "sign_in",
        outcome: "invalid_credentials",
        actorId: "web_unknown",
        actorLabel: "Unknown",
      });
      throw new DomainError("invalid_credentials", "That password is not right.");
    }

    const sessionId = randomToken(24);
    const label = parsed.data.label || "Web";
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    await store.transaction(async (tx) => {
      await tx.putSession({
        id: sessionId,
        tripId,
        label,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        revokedAt: null,
        epoch: await tx.getSessionEpoch(tripId),
      });
    });
    await auditAuthEvent(store, deps, {
      op: "sign_in",
      outcome: "ok",
      actorId: webPrincipalId(sessionId),
      actorLabel: label,
    });

    const token = signSession(
      {
        sid: sessionId,
        tid: tripId,
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        pv: auth.passwordVersion,
      },
      auth.sessionSecret,
    );
    return jsonResponse(200, { ok: true }, {
      "Set-Cookie": sessionCookie(auth.cookie, token, SESSION_TTL_SECONDS),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Ends this session on the server, so a copied cookie stops working too. */
export async function handleLogout(request: Request, deps: Deps): Promise<Response> {
  try {
    assertTrustedMutation(request, deps.config);
    const { session, store, auth, principal } = await requireWebSession(request, deps);
    await store.transaction((tx) =>
      tx.putSession({ ...session, revokedAt: deps.clock().toISOString() }),
    );
    await auditAuthEvent(store, deps, {
      op: "sign_out",
      outcome: "ok",
      actorId: principal.id,
      actorLabel: principal.label,
    });
    return jsonResponse(200, { ok: true }, { "Set-Cookie": clearedSessionCookie(auth.cookie) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Ends every session for this trip, on every device. */
export async function handleLogoutEverywhere(request: Request, deps: Deps): Promise<Response> {
  try {
    assertTrustedMutation(request, deps.config);
    const { store, auth, principal } = await requireWebSession(request, deps);
    const { tripId } = deps.config;
    await store.transaction(async (tx) => {
      await tx.setSessionEpoch(tripId, (await tx.getSessionEpoch(tripId)) + 1);
    });
    await auditAuthEvent(store, deps, {
      op: "sign_out_everywhere",
      outcome: "ok",
      actorId: principal.id,
      actorLabel: principal.label,
    });
    return jsonResponse(200, { ok: true }, { "Set-Cookie": clearedSessionCookie(auth.cookie) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleSessionInfo(request: Request, deps: Deps): Promise<Response> {
  try {
    const { session } = await requireWebSession(request, deps);
    return jsonResponse(200, { label: session.label, expiresAt: session.expiresAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleGetTrip(request: Request, deps: Deps): Promise<Response> {
  try {
    const session = await requireWebSession(request, deps);
    return jsonResponse(200, await getTripSnapshot(contextFor(session, deps)));
  } catch (error) {
    return toErrorResponse(error);
  }
}

const opsSchema = z.strictObject({
  op: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).optional(),
});

/** Runs one named operation for the signed-in person. */
export async function handleOperation(request: Request, deps: Deps): Promise<Response> {
  try {
    assertTrustedMutation(request, deps.config);
    const session = await requireWebSession(request, deps);
    await enforceRateLimit(session.store, `ops:${session.principal.id}`, OPS_LIMIT_PER_MINUTE, 60_000, deps.clock());
    const parsed = opsSchema.safeParse(await readJsonBody(request, MAX_OPS_BODY_BYTES));
    if (!parsed.success) throw new DomainError("validation_failed", "The request is not valid.");
    const result = await executeOperation(contextFor(session, deps), parsed.data.op, parsed.data.input ?? {});
    return jsonResponse(200, result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleActivity(request: Request, deps: Deps): Promise<Response> {
  try {
    const session = await requireWebSession(request, deps);
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = limitParam === null ? 50 : Number(limitParam);
    return jsonResponse(200, await executeOperation(contextFor(session, deps), "list_changes", { limit }));
  } catch (error) {
    return toErrorResponse(error);
  }
}

// The health route is public, so its database read is rationed. One reading
// per server instance is reused for 30 seconds. At most one read is ever in
// flight: simultaneous requests share it, and a new one is not started until
// the previous one has finished, even after its answer was given up on. A
// request waits at most 3 seconds and then reports the version as unknown;
// the store's own statement limit makes the read itself finish soon after.
const SCHEMA_READ_REUSE_MS = 30_000;
const SCHEMA_READ_DEADLINE_MS = 3_000;
const schemaReads = new WeakMap<Store, { at: number; value: number | null; running: Promise<number | null> | null }>();

function withinDeadline(read: Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SCHEMA_READ_DEADLINE_MS);
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

function rationedSchemaVersion(store: Store, nowMs: number): Promise<number | null> {
  const last = schemaReads.get(store) ?? { at: -Infinity, value: null, running: null };
  if (last.running) return withinDeadline(last.running);
  if (nowMs - last.at < SCHEMA_READ_REUSE_MS) return Promise.resolve(last.value);
  // A failed read reports null; its error text is never shown or logged. The
  // slot is freed only when the underlying read settles.
  const running = store
    .readSchemaVersion()
    .catch(() => null)
    .then((value) => {
      schemaReads.set(store, { at: nowMs, value, running: null });
      return value;
    });
  schemaReads.set(store, { ...last, running });
  return withinDeadline(running);
}

/** Public. Reports which parts are set up. Carries no trip data and no secrets. */
export async function handleHealth(_request: Request, deps: Deps): Promise<Response> {
  const { config, store } = deps;
  return jsonResponse(200, {
    deployment: config.deployment,
    signIn: config.auth.ready ? "ready" : "not_configured",
    storage: store ? store.kind : "not_configured",
    durableStorage: store?.durable ?? false,
    agentAccess: deps.agentAuth.mode,
    // Lets an operator confirm which code is live and which schema it found
    // before a migration or a dependent deploy. Neither is secret.
    schemaVersion: store ? await rationedSchemaVersion(store, deps.clock().getTime()) : null,
    commit: config.commit,
  });
}
