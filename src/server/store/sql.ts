// The small slice of a SQL driver the Postgres store needs. Keeping it this
// narrow lets the same store run on a real server through `pg` and, in tests,
// on an in-process Postgres with no server, network or credentials.
// (No "server-only" import: scripts/db-migrate.ts uses this file too.)

import { Pool } from "pg";

export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<SqlResult<Row>>;
  /** Runs a script of several statements, without parameters. Used for migrations. */
  execScript(text: string): Promise<void>;
}

export interface SqlDatabase extends SqlExecutor {
  /**
   * Runs `fn` in one SERIALIZABLE transaction on one connection. Commits when
   * `fn` returns and rolls back when it throws.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** SQLSTATE of a driver error, when it has one. */
export function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Pool settings for a connection string. With `verifyTls`, the connection
 * must be encrypted and the server's certificate must be valid for its host.
 * That is stated here explicitly rather than left to how the driver reads
 * `sslmode`, which differs between driver versions.
 */
export function pgPoolSettings(connectionString: string, options: { verifyTls: boolean }) {
  if (!options.verifyTls) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}

/**
 * Connects through `pg`. The connection string comes from the environment of
 * the running deployment and is never logged or returned.
 */
export function createPgDatabase(connectionString: string, options: { verifyTls: boolean }): SqlDatabase {
  const pool = new Pool({
    ...pgPoolSettings(connectionString, options),
    // Serverless instances are many and short-lived; keep each one's footprint small.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // Without a listener, an idle-connection error would crash the process.
  pool.on("error", () => undefined);

  const executor = (target: Pick<Pool, "query">): SqlExecutor => ({
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await target.query(text, params as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
    async execScript(text: string) {
      await target.query(text);
    },
  });

  return {
    ...executor(pool),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const value = await fn(executor(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
