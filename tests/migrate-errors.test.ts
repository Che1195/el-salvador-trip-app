// Regression tests: the migrate command must never print a secret, whatever
// the database driver puts in its errors. Every connection string, password,
// user and host below is made up for this test.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { describeMigrateFailure, runMigrate, UNKNOWN_FAILURE } from "@/server/store/migrate-command";
import { initializeDataScope, loadMigrations, MigrationRefusal } from "@/server/store/migrations";
import { emptyDatabase, MIGRATIONS_DIR } from "./support/pglite";

const SECRET_PASSWORD = "Pa55-never-print-me-7f3a";
const SECRET_USER = "trip_owner_never_print";
const SECRET_HOST = "ep-secret-host-never-print.example.invalid";
const SECRET_DATABASE = "private_db_never_print";
const SECRETS = [SECRET_PASSWORD, SECRET_USER, SECRET_HOST, SECRET_DATABASE, "postgres://", "postgresql://"];
const FAKE_URL = `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@${SECRET_HOST}/${SECRET_DATABASE}?sslmode=require`;

function expectNoSecret(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

// Shapes of error a driver or runtime can produce, each carrying secrets in a different place.
function leakyErrors(): unknown[] {
  const withCode = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
  return [
    new Error(`connect failed for ${FAKE_URL}`),
    new TypeError(`Invalid URL: ${FAKE_URL}`),
    withCode(`password authentication failed for user "${SECRET_USER}"`, { code: "28P01", severity: "FATAL" }),
    withCode(`database "${SECRET_DATABASE}" does not exist`, { code: "3D000" }),
    withCode(`getaddrinfo ENOTFOUND ${SECRET_HOST}`, { code: "ENOTFOUND", hostname: SECRET_HOST }),
    withCode("syntax error", { code: "42601", detail: FAKE_URL, hint: SECRET_PASSWORD, where: SECRET_USER }),
    withCode("wrapped", { cause: new Error(FAKE_URL) }),
    withCode("odd code", { code: FAKE_URL }),
    withCode("lowercase code", { code: `e${SECRET_PASSWORD}` }),
    FAKE_URL,
    { message: FAKE_URL, code: "28P01" },
    null,
    undefined,
  ];
}

describe("what the migrate command prints on failure", () => {
  it("replaces every unknown error with a fixed sentence, whatever the error holds", () => {
    for (const error of leakyErrors()) {
      const text = describeMigrateFailure(error);
      expectNoSecret(text);
      expect(text.startsWith(UNKNOWN_FAILURE)).toBe(true);
    }
  });

  it("keeps only a recognizable error code, to help diagnose without revealing anything", () => {
    const [, , auth, missing, dns, syntax, , odd, lower] = leakyErrors();
    expect(describeMigrateFailure(auth)).toBe(`${UNKNOWN_FAILURE} (code 28P01)`);
    expect(describeMigrateFailure(missing)).toBe(`${UNKNOWN_FAILURE} (code 3D000)`);
    expect(describeMigrateFailure(dns)).toBe(`${UNKNOWN_FAILURE} (code ENOTFOUND)`);
    expect(describeMigrateFailure(syntax)).toBe(`${UNKNOWN_FAILURE} (code 42601)`);
    expect(describeMigrateFailure(odd)).toBe(UNKNOWN_FAILURE);
    expect(describeMigrateFailure(lower)).toBe(UNKNOWN_FAILURE);
  });

  it("prints the command's own refusals in full", async () => {
    const db = emptyDatabase();
    const base = {
      db,
      migrations: loadMigrations(MIGRATIONS_DIR),
      dryRun: false,
      confirmProduction: false,
      seedSample: false,
      tripId: "trip_1",
      now: new Date("2031-03-01T12:00:00.000Z"),
      log: () => undefined,
    };
    const refusal = await runMigrate({ ...base, scope: "production" }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MigrationRefusal);
    expect(describeMigrateFailure(refusal)).toBe("Pass --confirm-production to change a production database.");

    await runMigrate({ ...base, scope: "preview" });
    const mismatch = await runMigrate({ ...base, scope: "production", confirmProduction: true }).catch((error: unknown) => error);
    expect(describeMigrateFailure(mismatch)).toBe('This database is marked "preview", not "production". Nothing was changed.');
  });

  it("does not echo an unrecognized environment marker read from the database", async () => {
    const db = emptyDatabase();
    await runMigrate({
      db,
      migrations: loadMigrations(MIGRATIONS_DIR),
      scope: "preview",
      dryRun: false,
      confirmProduction: false,
      seedSample: false,
      tripId: "trip_1",
      now: new Date(),
      log: () => undefined,
    });
    await db.query("UPDATE meta SET value = $1 WHERE key = 'data_scope'", [SECRET_PASSWORD]);
    const error = await initializeDataScope(db, "production").catch((caught: unknown) => caught);
    const text = describeMigrateFailure(error);
    expect(text).toBe('This database is already marked "another environment" and cannot become "production".');
    expectNoSecret(text);
  });
});

describe("the real script, end to end", () => {
  // Runs scripts/db-migrate.ts as a separate process. The connection strings
  // point at port 1 on this machine, which refuses at once, or cannot be
  // parsed at all: nothing leaves the computer and no database is touched.
  function runScript(databaseUrl: string) {
    const result = spawnSync("bun", ["--conditions", "react-server", "scripts/db-migrate.ts", "--scope", "preview"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  it("prints only the fixed message when the database refuses the connection", () => {
    const { status, output } = runScript(`postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:1/${SECRET_DATABASE}?sslmode=require`);
    expect(status).toBe(1);
    expect(output).toContain(`Failed: ${UNKNOWN_FAILURE}`);
    expectNoSecret(output);
    expect(output).not.toContain("127.0.0.1");
  });

  it("prints only the fixed message when the connection string cannot even be parsed", () => {
    const { status, output } = runScript(`postgresql://${SECRET_USER}:${SECRET_PASSWORD}@${SECRET_HOST}:not-a-port/${SECRET_DATABASE}`);
    expect(status).toBe(1);
    expect(output).toContain(`Failed: ${UNKNOWN_FAILURE}`);
    expectNoSecret(output);
  });
});
