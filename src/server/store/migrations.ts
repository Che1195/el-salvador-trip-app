// Versioned schema migrations and the environment marker.
//
// The running app never changes the schema. It only checks that the database
// is at the version this code expects and carries the right environment
// marker, and refuses to serve otherwise. Migrations are applied by
// scripts/db-migrate.ts, run deliberately by the person who owns the database.
// (No "server-only" import: that script uses this file.)

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sqlState, type SqlDatabase, type SqlExecutor } from "./sql";
import type { DataScope } from "./types";

/**
 * A refusal written by this code, whose message holds only migration numbers,
 * file names and environment names. Only these messages are ever shown by the
 * migrate command. Anything else, such as a driver error, can quote the
 * connection string, a user name or a host, and is replaced by a fixed text.
 */
export class MigrationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRefusal";
  }
}

/** The schema version this build of the app is written against. */
export const EXPECTED_SCHEMA_VERSION = 1;

export const DATA_SCOPES: readonly DataScope[] = ["local", "preview", "production"];

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigration(filename: string, sql: string): Migration {
  const match = FILE_PATTERN.exec(filename);
  if (!match) throw new MigrationRefusal(`Migration file name must look like 0001_name.sql: ${filename}`);
  return {
    version: Number(match[1]),
    name: match[2],
    sql,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
  };
}

/** Reads every migration in a folder, in order, and checks the numbering has no gaps. */
export function loadMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => parseMigration(name, readFileSync(join(directory, name), "utf8")));
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationRefusal(`Migrations must be numbered 0001, 0002, ... with no gaps; found ${migration.version}.`);
    }
  });
  return migrations;
}

const UNDEFINED_TABLE = "42P01";

interface AppliedRow {
  version: number;
  checksum: string;
}

async function appliedRows(db: SqlExecutor): Promise<AppliedRow[]> {
  try {
    const result = await db.query<AppliedRow>("SELECT version, checksum FROM schema_migrations ORDER BY version");
    return result.rows.map((row) => ({ version: Number(row.version), checksum: row.checksum }));
  } catch (error) {
    if (sqlState(error) === UNDEFINED_TABLE) return [];
    throw error;
  }
}

/** Highest applied migration, or 0 for a database that has none. */
export async function currentSchemaVersion(db: SqlExecutor): Promise<number> {
  const rows = await appliedRows(db);
  return rows.length === 0 ? 0 : rows[rows.length - 1].version;
}

/**
 * Compares the database with the migration files. Refuses if an applied
 * migration was edited afterwards, or if the database is ahead of the files.
 */
export async function pendingMigrations(db: SqlExecutor, migrations: readonly Migration[]): Promise<Migration[]> {
  const applied = await appliedRows(db);
  applied.forEach((row, index) => {
    if (row.version !== index + 1) throw new MigrationRefusal("The database's migration history has a gap.");
  });
  for (const row of applied) {
    const known = migrations.find((migration) => migration.version === row.version);
    if (!known) {
      throw new MigrationRefusal(`The database is at migration ${row.version}, which this code does not have.`);
    }
    if (known.checksum !== row.checksum) {
      throw new MigrationRefusal(`Migration ${row.version} was changed after it was applied. Add a new migration instead.`);
    }
  }
  return migrations.filter((migration) => migration.version > applied.length);
}

/** Applies every pending migration, each in its own transaction. Returns the versions applied. */
export async function applyMigrations(db: SqlDatabase, migrations: readonly Migration[]): Promise<number[]> {
  await db.execScript(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    integer primary key,
       name       text        not null,
       checksum   text        not null,
       applied_at timestamptz not null default now()
     )`,
  );
  const pending = await pendingMigrations(db, migrations);
  for (const migration of pending) {
    await db.transaction(async (tx) => {
      await tx.execScript(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
    });
  }
  return pending.map((migration) => migration.version);
}

function asScope(value: string): DataScope | null {
  return DATA_SCOPES.find((scope) => scope === value) ?? null;
}

/** The environment this database belongs to, or null if it has not been marked. */
export async function readDataScope(db: SqlExecutor): Promise<DataScope | null> {
  const result = await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'data_scope'");
  return result.rows.length === 0 ? null : asScope(result.rows[0].value);
}

/**
 * Marks a database as belonging to one environment. The marker is written
 * once. Asking for a different scope later is an error, never an update: a
 * database does not change environments.
 */
export async function initializeDataScope(db: SqlDatabase, scope: DataScope): Promise<void> {
  if (!DATA_SCOPES.includes(scope)) throw new MigrationRefusal("Scope must be local, preview or production.");
  await db.transaction(async (tx) => {
    const existing = await tx.query<{ value: string }>("SELECT value FROM meta WHERE key = 'data_scope'");
    if (existing.rows.length === 0) {
      await tx.query("INSERT INTO meta (key, value) VALUES ('data_scope', $1)", [scope]);
      return;
    }
    if (existing.rows[0].value !== scope) {
      const current = asScope(existing.rows[0].value) ?? "another environment";
      throw new MigrationRefusal(`This database is already marked "${current}" and cannot become "${scope}".`);
    }
  });
}
