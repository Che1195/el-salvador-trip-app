import { randomBytes } from "node:crypto";
import type { Scope } from "@/domain/model";
import { createFixtureAgentAuthenticator, type AgentPrincipal } from "@/server/agent-auth";
import { LOCAL_FIXTURE_PASSWORD, type Env } from "@/server/config";
import { buildDeps, type Deps } from "@/server/deps";
import { sha256Hex } from "@/server/hash";
import { handleLogin } from "@/server/handlers";
import type { OpContext, Principal } from "@/server/operations";
import type { Store } from "@/server/store/types";

export const ORIGIN = "http://localhost:3000";
export const START = new Date("2031-03-01T12:00:00.000Z");

export interface Harness {
  deps: Deps & { store: Store };
  store: Store;
  tripId: string;
  /** Moves the injected clock forward. */
  advance(ms: number): void;
  now(): Date;
}

/** Local fixture app with sample data and a controllable clock. */
export async function makeHarness(env: Env = {}): Promise<Harness> {
  let current = START.getTime();
  const deps = await buildDeps({ NODE_ENV: "test", ...env }, () => new Date(current));
  if (!deps.store) throw new Error("expected the local fixture store");
  const store = deps.store;
  return {
    deps: { ...deps, store },
    store,
    tripId: deps.config.tripId,
    advance(ms) {
      current += ms;
    },
    now: () => new Date(current),
  };
}

export interface RequestOptions {
  method?: string;
  cookie?: string | null;
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

/** Builds a request the way the app's own browser code sends it, unless told otherwise. */
export function makeRequest(path: string, options: RequestOptions = {}): Request {
  const method = options.method ?? "GET";
  const headers = new Headers();
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) {
    headers.set("Content-Type", "application/json");
    headers.set("X-Trip-Request", "1");
    if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  } else if (options.origin) {
    headers.set("Origin", options.origin);
  }
  if (options.cookie) headers.set("Cookie", options.cookie);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === "") headers.delete(name);
    else headers.set(name, value);
  }
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Request(`${ORIGIN}${path}`, { method, headers, ...(mutating && body !== undefined ? { body } : {}) });
}

/** Signs in with the fixture password and returns the Cookie header value. */
export async function signIn(h: Harness, label = "Test phone"): Promise<string> {
  const response = await handleLogin(
    makeRequest("/api/auth/login", { method: "POST", body: { password: LOCAL_FIXTURE_PASSWORD, label } }),
    h.deps,
  );
  if (response.status !== 200) throw new Error(`sign-in failed with ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in set no cookie");
  return setCookie.split(";")[0];
}

export function webPrincipal(h: Harness, id = "web_tester", label = "Tester"): Principal {
  return { type: "web", id, label, tripId: h.tripId };
}

export function agentPrincipal(h: Harness, scopes: Scope[], id = "agent_test"): AgentPrincipal {
  return { type: "agent", id, label: `Agent ${id}`, tripId: h.tripId, scopes };
}

export function ctxFor(h: Harness, principal: Principal): OpContext {
  return { principal, tripId: h.tripId, store: h.store, now: h.now() };
}

/**
 * Registers a fixture agent with a throwaway credential made up for this test
 * run. Nothing here is a real credential and nothing is written outside memory.
 */
export async function addFixtureAgent(
  h: Harness,
  scopes: Scope[],
  id = "agent_test",
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  await h.store.transaction((tx) =>
    tx.putAgent({
      id,
      name: `Agent ${id}`,
      grants: [{ tripId: h.tripId, scopes }],
      credentialHash: sha256Hex(token),
      createdAt: h.now().toISOString(),
      revokedAt: null,
    }),
  );
  return { id, token };
}

/** Same harness, with the fixture agent authenticator switched on. */
export function withAgentAuth(h: Harness): Harness {
  const agentAuth = createFixtureAgentAuthenticator(h.store, h.deps.config.deployment);
  return { ...h, deps: { ...h.deps, agentAuth } };
}

let keyCounter = 0;
export function key(): string {
  keyCounter += 1;
  return `test-key-${keyCounter.toString().padStart(6, "0")}`;
}
