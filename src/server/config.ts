// Turns environment variables into one validated configuration object.
//
// The rule throughout is fail closed: if a deployed environment is missing a
// secret or a store, the matching feature reports "not set up" and refuses
// requests. Nothing falls back to a fixture or a default secret in production.

import "server-only";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./hash";
import { hashPassword, MIN_DEPLOYED_N, parsePasswordHash } from "./password";
import type { DataScope } from "./store/types";

export type Env = Record<string, string | undefined>;
export type Deployment = "local" | "preview" | "production";

/** Password for the local development fixture only. It is refused everywhere else. */
export const LOCAL_FIXTURE_PASSWORD = "sample-trip-local";
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export type AuthConfig =
  | {
      ready: true;
      sessionSecret: Buffer;
      passwordHash: string;
      /** Changes whenever the password hash changes, which ends every session. */
      passwordVersion: string;
      cookie: { name: string; secure: boolean };
      /** True when running on the local fixture password. */
      fixture: boolean;
    }
  | { ready: false; reason: string };

export type StorageConfig =
  | { mode: "fixture"; scope: Exclude<DataScope, "production"> }
  /** The connection string is a secret: never log it or include it in a response. */
  | { mode: "postgres"; connectionString: string }
  | { mode: "unconfigured"; reason: string };

export type AgentAuthConfig =
  | { mode: "disabled"; reason: string }
  | {
      mode: "keys";
      /**
       * Local development only: SHA-256 of MCP_DEV_FIXTURE_TOKEN, which seeds
       * one agent record. Always null in a deployed environment.
       */
      localFixtureCredentialHash: string | null;
    };

export interface AppConfig {
  deployment: Deployment;
  tripId: string;
  trustedOrigins: readonly string[];
  /** Local only: also accept the loopback origin the request itself arrived on. */
  trustLoopbackRequestOrigin: boolean;
  auth: AuthConfig;
  storage: StorageConfig;
  agentAuth: AgentAuthConfig;
}

export function resolveDeployment(env: Env): Deployment {
  if (env.VERCEL_ENV === "preview") return "preview";
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "development") return "local";
  // An unrecognized hosted environment gets the strictest treatment.
  if (env.VERCEL) return "production";
  return env.NODE_ENV === "production" ? "production" : "local";
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.origin;
  } catch {
    return null;
  }
}

function resolveTrustedOrigins(env: Env, deployment: Deployment): string[] {
  const candidates = (env.APP_ORIGINS ?? "").split(",").map((part) => part.trim());
  // Vercel sets these itself; they name this deployment and its stable aliases.
  candidates.push(env.VERCEL_URL ?? "", env.VERCEL_BRANCH_URL ?? "");
  if (deployment === "production") candidates.push(env.VERCEL_PROJECT_PRODUCTION_URL ?? "");
  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const origin = parseOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

async function resolveAuth(env: Env, deployment: Deployment): Promise<AuthConfig> {
  const secret = env.SESSION_SECRET;
  const hash = env.TRIP_PASSWORD_HASH;
  const deployed = deployment !== "local";
  const cookie = deployed
    ? { name: "__Host-trip_session", secure: true }
    : { name: "trip_session", secure: false };

  if (secret !== undefined || hash !== undefined || deployed) {
    if (!secret || !hash) {
      return { ready: false, reason: "SESSION_SECRET and TRIP_PASSWORD_HASH must both be set." };
    }
    if (secret.length < 32) {
      return { ready: false, reason: "SESSION_SECRET must be at least 32 characters." };
    }
    const parsed = parsePasswordHash(hash);
    if (!parsed) {
      return { ready: false, reason: "TRIP_PASSWORD_HASH is not a valid scrypt hash." };
    }
    if (deployed && parsed.params.N < MIN_DEPLOYED_N) {
      return { ready: false, reason: "TRIP_PASSWORD_HASH uses too low a cost for a deployment." };
    }
    return {
      ready: true,
      sessionSecret: Buffer.from(secret, "utf8"),
      passwordHash: hash,
      passwordVersion: sha256Hex(hash).slice(0, 12),
      cookie,
      fixture: false,
    };
  }

  // Local development with nothing configured: a labeled fixture password and
  // a signing key that exists only in this process's memory.
  const fixtureHash = await hashPassword(LOCAL_FIXTURE_PASSWORD, { N: 2 ** 12, r: 8, p: 1 });
  return {
    ready: true,
    sessionSecret: randomBytes(32),
    passwordHash: fixtureHash,
    passwordVersion: sha256Hex(fixtureHash).slice(0, 12),
    cookie,
    fixture: true,
  };
}

const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

function resolvePostgres(connectionString: string, deployment: Deployment): StorageConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { mode: "unconfigured", reason: "DATABASE_URL is not a valid URL." };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { mode: "unconfigured", reason: "DATABASE_URL must be a postgres:// URL." };
  }
  if (deployment !== "local" && !TLS_MODES.has(url.searchParams.get("sslmode") ?? "")) {
    return { mode: "unconfigured", reason: "DATABASE_URL must require TLS (sslmode=require)." };
  }
  return { mode: "postgres", connectionString };
}

function resolveStorage(env: Env, deployment: Deployment): StorageConfig {
  // A configured database always wins. Whether this deployment may use it is
  // decided later, from the environment marker stored in the database itself.
  if (env.DATABASE_URL) return resolvePostgres(env.DATABASE_URL, deployment);
  if (deployment === "local") return { mode: "fixture", scope: "local" };
  if (deployment === "preview" && env.TRIP_FIXTURE_PREVIEW === "1") {
    // A preview may opt in to the sample fixture. Production never can.
    return { mode: "fixture", scope: "preview" };
  }
  return {
    mode: "unconfigured",
    reason: "No private database is connected to this environment yet.",
  };
}

function resolveAgentAuth(env: Env, deployment: Deployment): AgentAuthConfig {
  // The kill switch for every agent at once. Environment variables only reach
  // new deployments, so it takes effect on the next deploy.
  if (env.AGENT_ACCESS?.trim().toLowerCase() === "off") {
    return { mode: "disabled", reason: "AGENT_ACCESS is off." };
  }
  // The developer token is a local convenience. Anywhere else it is ignored,
  // so a deployed environment never seeds an agent from an environment variable.
  const token = deployment === "local" ? env.MCP_DEV_FIXTURE_TOKEN : undefined;
  const localFixtureCredentialHash = token && token.length >= 32 ? sha256Hex(token) : null;
  return { mode: "keys", localFixtureCredentialHash };
}

export async function loadConfig(env: Env): Promise<AppConfig> {
  const deployment = resolveDeployment(env);
  const tripId = env.TRIP_ID && /^[A-Za-z0-9_-]{1,64}$/.test(env.TRIP_ID) ? env.TRIP_ID : "trip_1";
  return {
    deployment,
    tripId,
    trustedOrigins: resolveTrustedOrigins(env, deployment),
    trustLoopbackRequestOrigin: deployment === "local",
    auth: await resolveAuth(env, deployment),
    storage: resolveStorage(env, deployment),
    agentAuth: resolveAgentAuth(env, deployment),
  };
}
