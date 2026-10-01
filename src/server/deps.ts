// Composition root: builds the one set of server dependencies for this process.

import "server-only";
import { SCOPES } from "@/domain/model";
import {
  createKeyAgentAuthenticator,
  disabledAgentAuthenticator,
  type AgentAuthenticator,
} from "./agent-auth";
import { loadConfig, type AppConfig, type Env } from "./config";
import { seedSampleTrip } from "./sample-data";
import { MemoryFixtureStore } from "./store/memory";
import { PostgresStore, StoreUnavailableError } from "./store/postgres";
import { createPgDatabase } from "./store/sql";
import type { Store } from "./store/types";

export interface Deps {
  config: AppConfig;
  /** Null when no store is configured. Every private route then answers 503. */
  store: Store | null;
  agentAuth: AgentAuthenticator;
  clock: () => Date;
}

export const LOCAL_FIXTURE_AGENT_ID = "agent_local_fixture";

/**
 * A deployment may only use a store that holds its own kind of data. This is
 * what keeps a preview from ever reading or editing production: even if a
 * preview were handed production's connection details by mistake, the store
 * reports scope "production" and is refused here.
 */
export function storeMatchesDeployment(store: Pick<Store, "scope">, config: Pick<AppConfig, "deployment">): boolean {
  return store.scope === config.deployment;
}

async function openPostgres(connectionString: string, verifyTls: boolean): Promise<Store | null> {
  const db = createPgDatabase(connectionString, { verifyTls });
  try {
    return await PostgresStore.open(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    // Only a fixed reason is logged. A driver error can quote the connection string.
    const reason = error instanceof StoreUnavailableError ? error.reason : "connection_failed";
    console.error(`[trip-app] database not usable: ${reason}`);
    return null;
  }
}

async function createConfiguredStore(config: AppConfig, clock: () => Date): Promise<Store | null> {
  if (config.storage.mode === "postgres") {
    return openPostgres(config.storage.connectionString, config.deployment !== "local");
  }
  if (config.storage.mode !== "fixture") return null;
  const store = new MemoryFixtureStore(config.storage.scope);
  await seedSampleTrip(store, config.tripId, clock());
  return store;
}

export async function buildDeps(
  env: Env,
  clock: () => Date = () => new Date(),
  createStore: (config: AppConfig, clock: () => Date) => Promise<Store | null> = createConfiguredStore,
): Promise<Deps> {
  const config = await loadConfig(env);

  let store = await createStore(config, clock);
  if (store && !storeMatchesDeployment(store, config)) {
    console.error(`[trip-app] refusing a "${store.scope}" store in a "${config.deployment}" deployment`);
    store = null;
  }

  let agentAuth = disabledAgentAuthenticator;
  if (store && config.agentAuth.mode === "keys") {
    const { localFixtureCredentialHash } = config.agentAuth;
    if (localFixtureCredentialHash) {
      // Local development only (config leaves the hash null elsewhere): one
      // agent record that the developer's own token opens.
      await store.transaction((tx) =>
        tx.putAgent({
          id: LOCAL_FIXTURE_AGENT_ID,
          name: "Local fixture agent",
          grants: [{ tripId: config.tripId, scopes: [...SCOPES] }],
          credentialHash: localFixtureCredentialHash,
          oauth: null,
          createdAt: clock().toISOString(),
          revokedAt: null,
        }),
      );
    }
    agentAuth = createKeyAgentAuthenticator(store);
  }

  return { config, store, agentAuth, clock };
}

// One instance per process, shared by pages and route handlers even when the
// bundler gives them separate module copies.
const globalSlot = globalThis as typeof globalThis & {
  __tripAppDeps?: { deps: Promise<Deps>; builtAt: number };
};

const DATABASE_RETRY_MS = 15_000;

export async function getDeps(): Promise<Deps> {
  const cached = globalSlot.__tripAppDeps;
  if (cached) {
    const deps = await cached.deps;
    // A database that was unreachable when this instance started may be back.
    // Try again, but not on every request.
    const databaseDown = deps.config.storage.mode === "postgres" && deps.store === null;
    if (!databaseDown || Date.now() - cached.builtAt < DATABASE_RETRY_MS) return deps;
    // Another request may have started the retry while this one was waiting.
    const latest = globalSlot.__tripAppDeps;
    if (latest && latest !== cached) return latest.deps;
  }
  const fresh = { deps: buildDeps(process.env), builtAt: Date.now() };
  globalSlot.__tripAppDeps = fresh;
  return fresh.deps;
}
