// Applies the schema migrations in db/migrations to the database named by
// DATABASE_URL, and marks which environment that database belongs to.
//
//   bun run db:migrate -- --scope preview --dry-run
//   bun run db:migrate -- --scope preview
//   bun run db:migrate -- --scope preview --seed-sample
//   bun run db:migrate -- --scope production --confirm-production
//
// Run it yourself, with DATABASE_URL set in your own shell for that one
// command. The URL is a secret: this script never prints it, and it should
// not be pasted into a chat or committed. On failure it prints only its own
// refusals or a fixed sentence with an error code, never a driver's message. The app itself never changes the
// schema; it only refuses to run if the schema or the marker is wrong.
//
// Status: the steps this performs are tested against an in-process Postgres.
// The script has not been run against a real database.

import { fileURLToPath } from "node:url";
import { describeMigrateFailure, runMigrate } from "../src/server/store/migrate-command";
import { DATA_SCOPES, loadMigrations } from "../src/server/store/migrations";
import { createPgDatabase, type SqlDatabase } from "../src/server/store/sql";
import type { DataScope } from "../src/server/store/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const scopeArg = args[args.indexOf("--scope") + 1];
const scope = args.includes("--scope") ? DATA_SCOPES.find((candidate) => candidate === scopeArg) : undefined;

if (!scope) {
  console.error("Say which environment this database is for: --scope local | preview | production");
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set in this shell.");
  process.exit(1);
}

let db: SqlDatabase | undefined;
try {
  // Inside the try: even a malformed connection string must not reach an
  // uncaught-error printout, which would show the string.
  db = createPgDatabase(connectionString, { verifyTls: (scope as DataScope) !== "local" });
  await runMigrate({
    db,
    migrations: loadMigrations(fileURLToPath(new URL("../db/migrations", import.meta.url))),
    scope,
    dryRun: flag("--dry-run"),
    confirmProduction: flag("--confirm-production"),
    seedSample: flag("--seed-sample"),
    tripId: process.env.TRIP_ID || "trip_1",
    now: new Date(),
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(`Failed: ${describeMigrateFailure(error)}`);
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => undefined);
}
