// Composition root: builds the one set of server dependencies for this process.

import "server-only";
import { SCOPES } from "@/domain/model";
import {
  createFixtureAgentAuthenticator,
  disabledAgentAuthenticator,
  type AgentAuthenticator,
} from "./agent-auth";
import { loadConfig, type AppConfig, type Env } from "./config";
import { seedSampleTrip } from "./sample-data";
import { MemoryFixtureStore } from "./store/memory";
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

async function createConfiguredStore(config: AppConfig, clock: () => Date): Promise<Store | null> {
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
  if (store && config.deployment === "local" && config.agentAuth.mode === "local-fixture") {
    const { credentialHash } = config.agentAuth;
    await store.transaction((tx) =>
      tx.putAgent({
        id: LOCAL_FIXTURE_AGENT_ID,
        name: "Local fixture agent",
        grants: [{ tripId: config.tripId, scopes: [...SCOPES] }],
        credentialHash,
        createdAt: clock().toISOString(),
        revokedAt: null,
      }),
    );
    agentAuth = createFixtureAgentAuthenticator(store, config.deployment);
  }

  return { config, store, agentAuth, clock };
}

// One instance per process, shared by pages and route handlers even when the
// bundler gives them separate module copies.
const globalSlot = globalThis as typeof globalThis & { __tripAppDeps?: Promise<Deps> };

export function getDeps(): Promise<Deps> {
  return (globalSlot.__tripAppDeps ??= buildDeps(process.env));
}
