// What `bun run db:migrate` does, separated from argument parsing and from
// the database connection so it can be tested without a server.

import { seedSampleTrip } from "../sample-data";
import { applyMigrations, currentSchemaVersion, initializeDataScope, pendingMigrations, readDataScope, type Migration } from "./migrations";
import { PostgresStore } from "./postgres";
import type { SqlDatabase } from "./sql";
import type { DataScope } from "./types";

export interface MigrateOptions {
  db: SqlDatabase;
  migrations: readonly Migration[];
  scope: DataScope;
  /** Report what would happen and change nothing. */
  dryRun: boolean;
  /** Must be true to touch a production database. */
  confirmProduction: boolean;
  /** Also load the fictitious sample trip. Refused for production. */
  seedSample: boolean;
  tripId: string;
  now: Date;
  log(line: string): void;
}

export interface MigrateResult {
  applied: number[];
  version: number;
  seeded: boolean;
}

export async function runMigrate(options: MigrateOptions): Promise<MigrateResult> {
  const { db, migrations, scope, log } = options;
  if (scope === "production" && options.seedSample) {
    throw new Error("Sample data is never loaded into a production database.");
  }
  if (scope === "production" && !options.dryRun && !options.confirmProduction) {
    throw new Error("Pass --confirm-production to change a production database.");
  }

  const before = await currentSchemaVersion(db);
  const pending = await pendingMigrations(db, migrations);
  const marker = before === 0 ? null : await readDataScope(db);
  if (marker !== null && marker !== scope) {
    throw new Error(`This database is marked "${marker}", not "${scope}". Nothing was changed.`);
  }

  log(`Schema version: ${before}. Pending: ${pending.length === 0 ? "none" : pending.map((m) => `${m.version} ${m.name}`).join(", ")}.`);
  log(`Environment marker: ${marker ?? "not set"}${marker === null ? `, would be set to "${scope}"` : ""}.`);
  if (options.dryRun) {
    log("Dry run: nothing was changed.");
    return { applied: [], version: before, seeded: false };
  }

  const applied = await applyMigrations(db, migrations);
  await initializeDataScope(db, scope);
  const version = await currentSchemaVersion(db);
  log(`Applied: ${applied.length === 0 ? "nothing" : applied.join(", ")}. Schema version is now ${version}.`);

  let seeded = false;
  if (options.seedSample) {
    const store = await PostgresStore.open(db);
    const existed = (await store.transaction((tx) => tx.getEntity(options.tripId, options.tripId))) !== null;
    await seedSampleTrip(store, options.tripId, options.now);
    seeded = !existed;
    log(seeded ? "Loaded the fictitious sample trip." : "A trip already exists; sample data was not loaded.");
  }
  return { applied, version, seeded };
}
