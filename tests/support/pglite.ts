// An in-process Postgres (PGlite, Postgres compiled to WebAssembly) behind the
// app's SqlDatabase interface. It needs no server, no network and no
// credentials, which is what lets the Postgres store be tested here at all.
//
// What this cannot show: PGlite has a single connection, so transactions run
// one after another. Genuine collisions between concurrent transactions only
// happen on a real server; the retry path for them is tested with a scripted
// fake in tests/postgres-store.test.ts.

import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, initializeDataScope, loadMigrations } from "@/server/store/migrations";
import type { SqlDatabase, SqlExecutor } from "@/server/store/sql";
import type { DataScope } from "@/server/store/types";

export const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

type Queryable = Pick<PGlite, "query" | "exec">;

function executor(target: Queryable): SqlExecutor {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await target.query<Row>(text, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async execScript(text: string) {
      await target.exec(text);
    },
  };
}

export function createPgliteDatabase(pg: PGlite): SqlDatabase {
  return {
    ...executor(pg),
    transaction: (fn) =>
      pg.transaction(async (tx) => {
        await tx.exec("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        return fn(executor(tx));
      }),
    close: () => pg.close(),
  };
}

/** A new, empty database: no tables at all. */
export function emptyDatabase(): SqlDatabase {
  return createPgliteDatabase(new PGlite());
}

/** A new database with every migration applied and an environment marker set. */
export async function migratedDatabase(scope: DataScope = "local"): Promise<SqlDatabase> {
  const db = emptyDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));
  await initializeDataScope(db, scope);
  return db;
}

const DATA_TABLES = [
  "entities",
  "changes",
  "audit_log",
  "idempotency_keys",
  "sessions",
  "session_epochs",
  "agent_grants",
  "agents",
  "rate_limits",
  "removal_requests",
];

let shared: Promise<SqlDatabase> | undefined;

/** One migrated database per test worker, emptied of data on each call. */
export async function cleanSharedDatabase(): Promise<SqlDatabase> {
  const db = await (shared ??= migratedDatabase("local"));
  await db.execScript(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  return db;
}
