// Postgres-specific behavior: migrations, the environment marker, startup
// checks, transaction retries and durable rate limits. Everything runs on an
// in-process Postgres or a scripted fake. No server, connection string or
// credential is involved, and nothing here has been run against a real
// database.

import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import { buildDeps } from "@/server/deps";
import { handleGetTrip, handleHealth } from "@/server/handlers";
import {
  applyMigrations,
  currentSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  initializeDataScope,
  loadMigrations,
  parseMigration,
  pendingMigrations,
  readDataScope,
} from "@/server/store/migrations";
import { runMigrate, type MigrateOptions } from "@/server/store/migrate-command";
import { PostgresStore, StoreUnavailableError } from "@/server/store/postgres";
import { pgPoolSettings, type SqlDatabase, type SqlExecutor } from "@/server/store/sql";
import type { StoreTx } from "@/server/store/types";
import { makeRequest } from "./support/harness";
import { emptyDatabase, migratedDatabase, MIGRATIONS_DIR } from "./support/pglite";

afterEach(() => {
  vi.restoreAllMocks();
});

async function unavailableReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StoreUnavailableError) return error.reason;
    throw error;
  }
  throw new Error("expected the database to be refused");
}

describe("migrations", () => {
  const migrations = loadMigrations(MIGRATIONS_DIR);

  it("has files numbered without gaps, matching the version the app expects", () => {
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    expect(migrations[migrations.length - 1].version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(readdirSync(MIGRATIONS_DIR).every((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))).toBe(true);
  });

  it("contain structure only: no inserted rows, no credentials", () => {
    for (const migration of migrations) {
      expect(migration.sql).not.toMatch(/\binsert\s+into\b/i);
      expect(migration.sql).not.toMatch(/postgres(ql)?:\/\//i);
      expect(migration.sql).not.toMatch(/\bpassword\b/i);
    }
  });

  it("apply to an empty database once, and do nothing the second time", async () => {
    const db = emptyDatabase();
    expect(await currentSchemaVersion(db)).toBe(0);
    expect(await applyMigrations(db, migrations)).toEqual(migrations.map((m) => m.version));
    expect(await currentSchemaVersion(db)).toBe(EXPECTED_SCHEMA_VERSION);
    expect(await applyMigrations(db, migrations)).toEqual([]);
    expect(await pendingMigrations(db, migrations)).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "agent_grants",
      "agents",
      "audit_log",
      "changes",
      "entities",
      "idempotency_keys",
      "meta",
      "rate_limits",
      "schema_migrations",
      "session_epochs",
      "sessions",
    ]);
  });

  it("applies only what is pending when a later migration is added", async () => {
    const db = emptyDatabase();
    await applyMigrations(db, migrations);
    const next = parseMigration(
      `${String(migrations.length + 1).padStart(4, "0")}_add_example.sql`,
      "create table example_only_in_this_test (id integer primary key);",
    );
    expect((await pendingMigrations(db, [...migrations, next])).map((m) => m.version)).toEqual([next.version]);
    expect(await applyMigrations(db, [...migrations, next])).toEqual([next.version]);
    expect(await currentSchemaVersion(db)).toBe(next.version);
  });

  it("leaves nothing behind when a migration fails part-way", async () => {
    const db = emptyDatabase();
    await applyMigrations(db, migrations);
    const broken = parseMigration(
      `${String(migrations.length + 1).padStart(4, "0")}_broken.sql`,
      "create table half_done (id integer primary key); select * from a_table_that_does_not_exist;",
    );
    await expect(applyMigrations(db, [...migrations, broken])).rejects.toThrow();
    expect(await currentSchemaVersion(db)).toBe(EXPECTED_SCHEMA_VERSION);
    const leftover = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'half_done'");
    expect(leftover.rows).toEqual([]);
  });

  it("refuses to continue if an applied migration was edited", async () => {
    const db = emptyDatabase();
    await applyMigrations(db, migrations);
    const edited = migrations.map((m, i) => (i === 0 ? parseMigration("0001_initial.sql", `${m.sql}\n-- edited later`) : m));
    await expect(applyMigrations(db, edited)).rejects.toThrow(/changed after it was applied/);
  });

  it("refuses a database that is ahead of the code", async () => {
    const db = emptyDatabase();
    const future = parseMigration(`${String(migrations.length + 1).padStart(4, "0")}_future.sql`, "select 1;");
    await applyMigrations(db, [...migrations, future]);
    await expect(pendingMigrations(db, migrations)).rejects.toThrow(/does not have/);
  });

  it("rejects badly named or misnumbered files", () => {
    expect(() => parseMigration("initial.sql", "select 1;")).toThrow();
    expect(() => parseMigration("1_initial.sql", "select 1;")).toThrow();
    expect(() => parseMigration("0001-Initial.sql", "select 1;")).toThrow();
  });
});

describe("environment marker", () => {
  it("is written once and can never change to another environment", async () => {
    const db = emptyDatabase();
    await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));
    expect(await readDataScope(db)).toBeNull();
    await initializeDataScope(db, "preview");
    expect(await readDataScope(db)).toBe("preview");
    await initializeDataScope(db, "preview"); // Saying the same thing again is fine.
    await expect(initializeDataScope(db, "production")).rejects.toThrow(/already marked "preview"/);
    expect(await readDataScope(db)).toBe("preview");
  });

  it("treats an unrecognized marker as no marker", async () => {
    const db = emptyDatabase();
    await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));
    await db.query("INSERT INTO meta (key, value) VALUES ('data_scope', 'staging')");
    expect(await readDataScope(db)).toBeNull();
    expect(await unavailableReason(PostgresStore.open(db))).toBe("scope_marker_missing");
  });
});

describe("opening the store", () => {
  it("refuses a database with no schema or no marker", async () => {
    expect(await unavailableReason(PostgresStore.open(emptyDatabase()))).toBe("schema_missing");

    const unmarked = emptyDatabase();
    await applyMigrations(unmarked, loadMigrations(MIGRATIONS_DIR));
    expect(await unavailableReason(PostgresStore.open(unmarked))).toBe("scope_marker_missing");

  });

  it("accepts a database migrated ahead of this code, so migrations can be applied before deploying", async () => {
    const ahead = await migratedDatabase("preview");
    await ahead.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'future', 'x')", [EXPECTED_SCHEMA_VERSION + 1]);
    const store = await PostgresStore.open(ahead);
    expect(store.scope).toBe("preview");
    // It still works normally on the tables it knows.
    await store.transaction((tx) => tx.setSessionEpoch("trip_1", 2));
    expect(await store.transaction((tx) => tx.getSessionEpoch("trip_1"))).toBe(2);
  });

  it("takes its scope from the database, not from configuration", async () => {
    expect((await PostgresStore.open(await migratedDatabase("preview"))).scope).toBe("preview");
    const production = await PostgresStore.open(await migratedDatabase("production"));
    expect(production.scope).toBe("production");
    expect(production.kind).toBe("postgres");
    expect(production.durable).toBe(true);
  });
});

describe("a deployment only uses a database of its own environment", () => {
  const preview = { VERCEL: "1", VERCEL_ENV: "preview" };
  const production = { VERCEL: "1", VERCEL_ENV: "production" };

  it("refuses production data in a preview, and preview data in production", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const productionStore = await PostgresStore.open(await migratedDatabase("production"));
    const previewStore = await PostgresStore.open(await migratedDatabase("preview"));

    expect((await buildDeps(preview, undefined, async () => productionStore)).store).toBeNull();
    expect((await buildDeps(production, undefined, async () => previewStore)).store).toBeNull();
    expect((await buildDeps({ NODE_ENV: "development" }, undefined, async () => productionStore)).store).toBeNull();
    expect(logged).toHaveBeenCalledTimes(3);

    expect((await buildDeps(preview, undefined, async () => previewStore)).store).toBe(previewStore);
    expect((await buildDeps(production, undefined, async () => productionStore)).store).toBe(productionStore);
  });

  it("serves nothing from a refused database", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const productionStore = await PostgresStore.open(await migratedDatabase("production"));
    const deps = await buildDeps(preview, undefined, async () => productionStore);
    const health = await (await handleHealth(makeRequest("/api/health"), deps)).json();
    expect(health.storage).toBe("not_configured");
    expect((await handleGetTrip(makeRequest("/api/trip"), deps)).status).toBe(503);
  });

  it("keeps sample data out of a production database", async () => {
    const { seedSampleTrip } = await import("@/server/sample-data");
    const productionStore = await PostgresStore.open(await migratedDatabase("production"));
    await expect(seedSampleTrip(productionStore, "trip_1", new Date())).rejects.toThrow(/never be written to production/);
    expect(await productionStore.transaction((tx) => tx.getEntity("trip_1", "trip_1"))).toBeNull();
  });
});

describe("database configuration", () => {
  const FAKE_URL = "postgresql://user:not-a-real-password@db.invalid/app?sslmode=require";

  it("selects Postgres whenever a database URL is set, and nothing else in production", async () => {
    const production = { VERCEL: "1", VERCEL_ENV: "production" };
    expect((await loadConfig(production)).storage.mode).toBe("unconfigured");
    expect((await loadConfig({ ...production, TRIP_FIXTURE_PREVIEW: "1" })).storage.mode).toBe("unconfigured");
    expect((await loadConfig({ ...production, DATABASE_URL: FAKE_URL })).storage.mode).toBe("postgres");
    expect((await loadConfig({ NODE_ENV: "development", DATABASE_URL: "postgres://localhost/app" })).storage.mode).toBe("postgres");
    // A database URL takes priority over the preview fixture flag.
    const preview = await loadConfig({ VERCEL: "1", VERCEL_ENV: "preview", TRIP_FIXTURE_PREVIEW: "1", DATABASE_URL: FAKE_URL });
    expect(preview.storage.mode).toBe("postgres");
  });

  it("refuses a deployed database URL that is malformed or does not require TLS", async () => {
    const production = { VERCEL: "1", VERCEL_ENV: "production" };
    for (const url of ["not a url", "https://db.invalid/app", "postgresql://u:p@db.invalid/app", "postgresql://u:p@db.invalid/app?sslmode=disable", "postgresql://u:p@db.invalid/app?sslmode=prefer"]) {
      const config = await loadConfig({ ...production, DATABASE_URL: url });
      expect(config.storage.mode, url).toBe("unconfigured");
      // The refusal message must not repeat the URL.
      expect(JSON.stringify(config.storage)).not.toContain("db.invalid");
    }
  });

  it("verifies the server certificate in deployments, whatever the driver makes of sslmode", () => {
    const deployed = pgPoolSettings("postgresql://u:p@db.invalid/app?sslmode=require&application_name=trip", { verifyTls: true });
    expect(deployed.ssl).toEqual({ rejectUnauthorized: true });
    expect(deployed.connectionString).toBe("postgresql://u:p@db.invalid/app?application_name=trip");
    expect(pgPoolSettings("postgres://localhost/app", { verifyTls: false })).toEqual({ connectionString: "postgres://localhost/app" });
  });

  it("never reveals the connection string in the health report", async () => {
    const store = await PostgresStore.open(await migratedDatabase("production"));
    const deps = await buildDeps({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: FAKE_URL }, undefined, async () => store);
    const text = await (await handleHealth(makeRequest("/api/health"), deps)).text();
    expect(text).not.toMatch(/not-a-real-password|db\.invalid|postgres(ql)?:/);
    expect(JSON.parse(text)).toMatchObject({ storage: "postgres", durableStorage: true });
  });

  it("logs only a fixed reason when the database cannot be reached", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Port 1 on the local machine refuses immediately; nothing leaves this computer.
    const unreachable = "postgresql://user:not-a-real-password@127.0.0.1:1/app?sslmode=require";
    const deps = await buildDeps({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: unreachable });
    expect(deps.store).toBeNull();
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain("connection_failed");
    expect(output).not.toMatch(/not-a-real-password|127\.0\.0\.1/);
  });
});

// A scripted database: each transaction attempt fails with the next queued
// SQLSTATE, or succeeds when the queue is empty.
function scriptedDatabase(failures: (string | null)[]) {
  const attempts: number[] = [];
  const sql: SqlExecutor = {
    async query<Row>(text: string) {
      if (text.includes("schema_migrations")) return { rows: [{ version: EXPECTED_SCHEMA_VERSION, checksum: "x" }] as Row[], rowCount: 1 };
      if (text.includes("data_scope")) return { rows: [{ value: "local" }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async execScript() {},
  };
  const db: SqlDatabase = {
    ...sql,
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>) {
      attempts.push(attempts.length + 1);
      const value = await fn(sql);
      const failure = failures.shift();
      if (failure) throw Object.assign(new Error("simulated"), { code: failure });
      return value;
    },
    async close() {},
  };
  return { db, attempts };
}

describe("transaction retries", () => {
  const noWait = { sleep: async () => undefined, random: () => 0.5 };

  it("runs the work again after a serialization failure or a deadlock", async () => {
    const { db, attempts } = scriptedDatabase(["40001", "40P01"]);
    const store = await PostgresStore.open(db, noWait);
    let runs = 0;
    const result = await store.transaction(async (tx: StoreTx) => {
      runs += 1;
      await tx.getSessionEpoch("trip_a");
      return "done";
    });
    expect(result).toBe("done");
    expect(runs).toBe(3);
    expect(attempts).toHaveLength(3);
  });

  it("retries a unique-key collision, which is how two racing inserts surface", async () => {
    const { db, attempts } = scriptedDatabase(["23505"]);
    const store = await PostgresStore.open(db, noWait);
    expect(await store.transaction(async () => 1)).toBe(1);
    expect(attempts).toHaveLength(2);
  });

  it("gives up after the attempt limit and reports the last failure", async () => {
    const { db, attempts } = scriptedDatabase(Array.from({ length: 10 }, () => "40001"));
    const store = await PostgresStore.open(db, { ...noWait, maxAttempts: 4 });
    await expect(store.transaction(async () => 1)).rejects.toMatchObject({ code: "40001" });
    expect(attempts).toHaveLength(4);
  });

  it("does not retry other database errors or errors thrown by the work itself", async () => {
    const constraint = scriptedDatabase(["23514"]);
    const store = await PostgresStore.open(constraint.db, noWait);
    await expect(store.transaction(async () => 1)).rejects.toMatchObject({ code: "23514" });
    expect(constraint.attempts).toHaveLength(1);

    const clean = scriptedDatabase([]);
    const other = await PostgresStore.open(clean.db, noWait);
    await expect(other.transaction(async () => Promise.reject(new Error("domain refusal")))).rejects.toThrow("domain refusal");
    expect(clean.attempts).toHaveLength(1);
  });

  it("waits longer before each retry, with jitter", async () => {
    const { db } = scriptedDatabase(["40001", "40001", "40001"]);
    const waits: number[] = [];
    const store = await PostgresStore.open(db, { baseDelayMs: 10, random: () => 1, sleep: async (ms) => void waits.push(ms) });
    await store.transaction(async () => 1);
    expect(waits).toEqual([10, 20, 40]);

    const low = scriptedDatabase(["40001"]);
    const lowWaits: number[] = [];
    await (await PostgresStore.open(low.db, { baseDelayMs: 10, random: () => 0, sleep: async (ms) => void lowWaits.push(ms) })).transaction(async () => 1);
    expect(lowWaits).toEqual([5]);
  });
});

describe("durable rate limits", () => {
  it("shares one count between separate server instances", async () => {
    const db = await migratedDatabase("preview");
    // Two store objects over one database stand in for two serverless instances.
    const first = await PostgresStore.open(db);
    const second = await PostgresStore.open(db);
    const now = new Date("2031-03-01T12:00:00.000Z");
    expect((await first.hitRateLimit("login:all", 3, 60_000, now)).allowed).toBe(true);
    expect((await second.hitRateLimit("login:all", 3, 60_000, now)).allowed).toBe(true);
    expect((await first.hitRateLimit("login:all", 3, 60_000, now)).allowed).toBe(true);
    expect((await second.hitRateLimit("login:all", 3, 60_000, now)).allowed).toBe(false);
    expect((await first.hitRateLimit("login:all", 3, 60_000, now)).allowed).toBe(false);
  });

  it("drops windows older than a day", async () => {
    const db = await migratedDatabase("preview");
    const store = await PostgresStore.open(db);
    await store.hitRateLimit("old", 5, 60_000, new Date("2031-03-01T12:00:00.000Z"));
    await store.hitRateLimit("recent", 5, 60_000, new Date("2031-03-02T11:30:00.000Z"));
    await store.hitRateLimit("new", 5, 60_000, new Date("2031-03-02T12:30:00.000Z"));
    const keys = await db.query<{ key: string }>("SELECT key FROM rate_limits ORDER BY key");
    expect(keys.rows.map((r) => r.key)).toEqual(["new", "recent"]);
  });
});

describe("data survives a new store object", () => {
  it("keeps records and sessions when the app restarts on the same database", async () => {
    const db = await migratedDatabase("preview");
    const before = await PostgresStore.open(db);
    await before.transaction(async (tx) => {
      await tx.putEntity({ tripId: "t", id: "i", kind: "notes", revision: 1, data: { title: "kept", body: "" }, createdAt: "2031-03-01T12:00:00.000Z", updatedAt: "2031-03-01T12:00:00.000Z", updatedBy: "x", deletedAt: null });
      await tx.putSession({ id: "s", tripId: "t", label: "Phone", createdAt: "2031-03-01T12:00:00.000Z", expiresAt: "2031-03-15T12:00:00.000Z", revokedAt: null, epoch: 0 });
    });
    const after = await PostgresStore.open(db);
    await after.transaction(async (tx) => {
      expect((await tx.getEntity("t", "i"))?.data.title).toBe("kept");
      expect((await tx.getSession("s"))?.label).toBe("Phone");
    });
  });
});

describe("the migrate command", () => {
  function options(db: SqlDatabase, overrides: Partial<MigrateOptions> = {}) {
    const lines: string[] = [];
    const opts: MigrateOptions = {
      db,
      migrations: loadMigrations(MIGRATIONS_DIR),
      scope: "preview",
      dryRun: false,
      confirmProduction: false,
      seedSample: false,
      tripId: "trip_1",
      now: new Date("2031-03-01T12:00:00.000Z"),
      log: (line) => lines.push(line),
      ...overrides,
    };
    return { opts, lines };
  }

  it("changes nothing on a dry run, and says what it would do", async () => {
    const db = emptyDatabase();
    const { opts, lines } = options(db, { dryRun: true });
    expect(await runMigrate(opts)).toEqual({ applied: [], version: 0, seeded: false });
    expect(await currentSchemaVersion(db)).toBe(0);
    expect(lines.join("\n")).toContain("Pending: 1 initial");
    expect(lines.join("\n")).toContain("Dry run: nothing was changed.");
  });

  it("migrates, marks the environment, and leaves a database the app accepts", async () => {
    const db = emptyDatabase();
    const result = await runMigrate(options(db).opts);
    expect(result).toEqual({ applied: [EXPECTED_SCHEMA_VERSION], version: EXPECTED_SCHEMA_VERSION, seeded: false });
    const store = await PostgresStore.open(db);
    expect(store.scope).toBe("preview");
    // Running it again is harmless.
    expect((await runMigrate(options(db).opts)).applied).toEqual([]);
  });

  it("refuses to treat a database as a different environment", async () => {
    const db = emptyDatabase();
    await runMigrate(options(db).opts);
    await expect(runMigrate(options(db, { scope: "production", confirmProduction: true }).opts)).rejects.toThrow(/marked "preview", not "production"/);
    expect(await readDataScope(db)).toBe("preview");
  });

  it("needs explicit confirmation for production and never loads sample data there", async () => {
    const db = emptyDatabase();
    await expect(runMigrate(options(db, { scope: "production" }).opts)).rejects.toThrow(/--confirm-production/);
    expect(await currentSchemaVersion(db)).toBe(0);
    await expect(runMigrate(options(db, { scope: "production", confirmProduction: true, seedSample: true }).opts)).rejects.toThrow(/never loaded into a production/);
    expect(await currentSchemaVersion(db)).toBe(0);
    // A dry run against production is allowed: it reads only.
    expect((await runMigrate(options(db, { scope: "production", dryRun: true }).opts)).applied).toEqual([]);

    await runMigrate(options(db, { scope: "production", confirmProduction: true }).opts);
    const store = await PostgresStore.open(db);
    expect(store.scope).toBe("production");
    expect(await store.transaction((tx) => tx.listEntities("trip_1", "packing"))).toEqual([]);
  });

  it("loads the sample trip into a preview database once", async () => {
    const db = emptyDatabase();
    expect((await runMigrate(options(db, { seedSample: true }).opts)).seeded).toBe(true);
    const store = await PostgresStore.open(db);
    const trip = await store.transaction((tx) => tx.getEntity("trip_1", "trip_1"));
    expect(trip?.data.isSample).toBe(true);
    expect((await runMigrate(options(db, { seedSample: true }).opts)).seeded).toBe(false);
  });
});
