// Durable store on Postgres. It implements the same contract as the local
// fixture (./types.ts), and tests/store-contract.test.ts runs one suite
// against both.
//
// Trip-scoping invariant: every statement that touches trip content filters
// on the trip id passed in. No query reads "all rows".

import "server-only";
import type { EntityKind, Scope } from "@/domain/model";
import { ACCEPTED_SCHEMA_VERSIONS, currentSchemaVersion, readDataScope } from "./migrations";
import { sqlState, type SqlDatabase, type SqlExecutor } from "./sql";
import {
  StaleWriteError,
  type AgentRecord,
  type AuditQuery,
  type AuditRecord,
  type ChangeRecord,
  type DataScope,
  type IdempotencyRecord,
  type JsonObject,
  type OAuthIdentity,
  type RateLimitResult,
  type SessionRecord,
  type Store,
  type StoredEntity,
  type StoreTx,
} from "./types";

export type StoreUnavailableReason =
  | "schema_missing"
  | "schema_behind"
  | "schema_unknown"
  | "scope_marker_missing";

/** The database is reachable but must not be used. The reason is safe to log. */
export class StoreUnavailableError extends Error {
  constructor(readonly reason: StoreUnavailableReason) {
    super(`database refused: ${reason}`);
    this.name = "StoreUnavailableError";
  }
}

// Postgres reports these when concurrent transactions collide. The work was
// rolled back in full, so running it again is safe and is the expected remedy.
//   40001 serialization_failure, 40P01 deadlock_detected,
//   23505 unique_violation (two transactions inserting the same key: on retry
//         the second one sees the first one's row and takes the normal path).
const RETRYABLE_STATES = new Set(["40001", "40P01", "23505"]);

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 15,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

const json = (value: unknown) => JSON.stringify(value);

interface EntityRow {
  trip_id: string;
  id: string;
  kind: EntityKind;
  revision: number;
  data: JsonObject;
  created_at: unknown;
  updated_at: unknown;
  updated_by: string;
  deleted_at: unknown;
}

const ENTITY_COLUMNS = "trip_id, id, kind, revision, data, created_at, updated_at, updated_by, deleted_at";

function toEntity(row: EntityRow): StoredEntity {
  return {
    tripId: row.trip_id,
    id: row.id,
    kind: row.kind,
    revision: Number(row.revision),
    data: row.data,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
    deletedAt: isoOrNull(row.deleted_at),
  };
}

interface AgentRow {
  id: string;
  name: string;
  credential_hash: string | null;
  oauth_issuer: string | null;
  oauth_subject: string | null;
  created_at: unknown;
  revoked_at: unknown;
}

const AGENT_COLUMNS = "id, name, credential_hash, oauth_issuer, oauth_subject, created_at, revoked_at";

class PostgresTx implements StoreTx {
  constructor(private readonly sql: SqlExecutor) {}

  async getEntity(tripId: string, id: string) {
    const result = await this.sql.query<EntityRow>(
      `SELECT ${ENTITY_COLUMNS} FROM entities WHERE trip_id = $1 AND id = $2`,
      [tripId, id],
    );
    return result.rows.length === 0 ? null : toEntity(result.rows[0]);
  }

  async listEntities(tripId: string, kind: EntityKind, options?: { includeDeleted?: boolean }) {
    const result = await this.sql.query<EntityRow>(
      `SELECT ${ENTITY_COLUMNS} FROM entities
       WHERE trip_id = $1 AND kind = $2 ${options?.includeDeleted ? "" : "AND deleted_at IS NULL"}
       ORDER BY created_at, id`,
      [tripId, kind],
    );
    return result.rows.map(toEntity);
  }

  async putEntity(entity: StoredEntity) {
    // Revision 1 must be a new row; any later revision must replace exactly
    // the one before it. Either statement touching no row is a stale write.
    const result =
      entity.revision === 1
        ? await this.sql.query(
            `INSERT INTO entities (${ENTITY_COLUMNS})
             VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, $7, $8)
             ON CONFLICT (trip_id, id) DO NOTHING
             RETURNING id`,
            [entity.tripId, entity.id, entity.kind, json(entity.data), entity.createdAt, entity.updatedAt, entity.updatedBy, entity.deletedAt],
          )
        : await this.sql.query(
            `UPDATE entities
             SET kind = $3, revision = $4, data = $5::jsonb, updated_at = $6, updated_by = $7, deleted_at = $8
             WHERE trip_id = $1 AND id = $2 AND revision = $4 - 1
             RETURNING id`,
            [entity.tripId, entity.id, entity.kind, entity.revision, json(entity.data), entity.updatedAt, entity.updatedBy, entity.deletedAt],
          );
    if (result.rows.length !== 1) throw new StaleWriteError(entity.id);
  }

  async appendChange(change: ChangeRecord) {
    await this.sql.query(
      `INSERT INTO changes (trip_id, id, batch_id, entity_id, kind, action, before, result_revision, at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        change.tripId,
        change.id,
        change.batchId,
        change.entityId,
        change.kind,
        change.action,
        change.before === null ? null : json(change.before),
        change.resultRevision,
        change.at,
        change.actorId,
      ],
    );
  }

  private toChange(row: Record<string, unknown>): ChangeRecord {
    return {
      tripId: row.trip_id as string,
      id: row.id as string,
      batchId: row.batch_id as string,
      entityId: row.entity_id as string,
      kind: row.kind as EntityKind,
      action: row.action as ChangeRecord["action"],
      before: (row.before as StoredEntity | null) ?? null,
      resultRevision: Number(row.result_revision),
      at: iso(row.at),
      actorId: row.actor_id as string,
    };
  }

  async getChange(tripId: string, id: string) {
    const result = await this.sql.query(
      `SELECT trip_id, id, batch_id, entity_id, kind, action, before, result_revision, at, actor_id
       FROM changes WHERE trip_id = $1 AND id = $2`,
      [tripId, id],
    );
    return result.rows.length === 0 ? null : this.toChange(result.rows[0]);
  }

  async listChangesByBatch(tripId: string, batchId: string) {
    const result = await this.sql.query(
      `SELECT trip_id, id, batch_id, entity_id, kind, action, before, result_revision, at, actor_id
       FROM changes WHERE trip_id = $1 AND batch_id = $2 ORDER BY seq`,
      [tripId, batchId],
    );
    return result.rows.map((row) => this.toChange(row));
  }

  async appendAudit(entry: AuditRecord) {
    await this.sql.query(
      `INSERT INTO audit_log (trip_id, id, at, actor_type, actor_id, actor_label, op, kind, entity_id, batch_id, change_id, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.tripId,
        entry.id,
        entry.at,
        entry.actorType,
        entry.actorId,
        entry.actorLabel,
        entry.op,
        entry.kind,
        entry.entityId,
        entry.batchId,
        entry.changeId,
        entry.outcome,
      ],
    );
  }

  async listAudit(tripId: string, query: AuditQuery) {
    const params: unknown[] = [tripId];
    const where = ["trip_id = $1"];
    if (query.batchId !== undefined) {
      params.push(query.batchId);
      where.push(`batch_id = $${params.length}`);
    }
    if (query.kinds) {
      if (query.kinds.length === 0) return [];
      const placeholders = query.kinds.map((kind) => {
        params.push(kind);
        return `$${params.length}`;
      });
      where.push(`kind IN (${placeholders.join(", ")})`);
    }
    params.push(query.limit);
    const result = await this.sql.query<Record<string, unknown>>(
      `SELECT trip_id, id, at, actor_type, actor_id, actor_label, op, kind, entity_id, batch_id, change_id, outcome
       FROM audit_log WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(
      (row): AuditRecord => ({
        tripId: row.trip_id as string,
        id: row.id as string,
        at: iso(row.at),
        actorType: row.actor_type as AuditRecord["actorType"],
        actorId: row.actor_id as string,
        actorLabel: row.actor_label as string,
        op: row.op as string,
        kind: (row.kind as EntityKind | null) ?? null,
        entityId: (row.entity_id as string | null) ?? null,
        batchId: (row.batch_id as string | null) ?? null,
        changeId: (row.change_id as string | null) ?? null,
        outcome: row.outcome as string,
      }),
    );
  }

  async getIdempotency(tripId: string, principalId: string, key: string) {
    const result = await this.sql.query<{ request_hash: string; result: JsonObject; at: unknown }>(
      `SELECT request_hash, result, at FROM idempotency_keys
       WHERE trip_id = $1 AND principal_id = $2 AND key = $3`,
      [tripId, principalId, key],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { tripId, principalId, key, requestHash: row.request_hash, result: row.result, at: iso(row.at) };
  }

  async putIdempotency(record: IdempotencyRecord) {
    await this.sql.query(
      `INSERT INTO idempotency_keys (trip_id, principal_id, key, request_hash, result, at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [record.tripId, record.principalId, record.key, record.requestHash, json(record.result), record.at],
    );
  }

  async getSession(id: string) {
    const result = await this.sql.query<Record<string, unknown>>(
      "SELECT id, trip_id, label, created_at, expires_at, revoked_at, epoch FROM sessions WHERE id = $1",
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id as string,
      tripId: row.trip_id as string,
      label: row.label as string,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      revokedAt: isoOrNull(row.revoked_at),
      epoch: Number(row.epoch),
    };
  }

  async putSession(session: SessionRecord) {
    await this.sql.query(
      `INSERT INTO sessions (id, trip_id, label, created_at, expires_at, revoked_at, epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label, expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at, epoch = EXCLUDED.epoch`,
      [session.id, session.tripId, session.label, session.createdAt, session.expiresAt, session.revokedAt, session.epoch],
    );
  }

  async getSessionEpoch(tripId: string) {
    const result = await this.sql.query<{ epoch: number }>("SELECT epoch FROM session_epochs WHERE trip_id = $1", [tripId]);
    return result.rows.length === 0 ? 0 : Number(result.rows[0].epoch);
  }

  async setSessionEpoch(tripId: string, epoch: number) {
    await this.sql.query(
      `INSERT INTO session_epochs (trip_id, epoch) VALUES ($1, $2)
       ON CONFLICT (trip_id) DO UPDATE SET epoch = EXCLUDED.epoch`,
      [tripId, epoch],
    );
  }

  private async withGrants(rows: AgentRow[]): Promise<AgentRecord[]> {
    const agents: AgentRecord[] = [];
    for (const row of rows) {
      const grants = await this.sql.query<{ trip_id: string; scopes: Scope[] }>(
        "SELECT trip_id, scopes FROM agent_grants WHERE agent_id = $1 ORDER BY trip_id",
        [row.id],
      );
      agents.push({
        id: row.id,
        name: row.name,
        grants: grants.rows.map((grant) => ({ tripId: grant.trip_id, scopes: grant.scopes })),
        credentialHash: row.credential_hash,
        oauth:
          row.oauth_issuer !== null && row.oauth_subject !== null
            ? { issuer: row.oauth_issuer, subject: row.oauth_subject }
            : null,
        createdAt: iso(row.created_at),
        revokedAt: isoOrNull(row.revoked_at),
      });
    }
    return agents;
  }

  async getAgent(id: string) {
    const result = await this.sql.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]);
    return (await this.withGrants(result.rows))[0] ?? null;
  }

  async getAgentByCredentialHash(hash: string) {
    const result = await this.sql.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE credential_hash = $1`, [hash]);
    return (await this.withGrants(result.rows))[0] ?? null;
  }

  async getAgentByOAuthIdentity(identity: OAuthIdentity) {
    const result = await this.sql.query<AgentRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE oauth_issuer = $1 AND oauth_subject = $2`,
      [identity.issuer, identity.subject],
    );
    return (await this.withGrants(result.rows))[0] ?? null;
  }

  async listAgents(tripId: string) {
    const result = await this.sql.query<AgentRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents
       WHERE id IN (SELECT agent_id FROM agent_grants WHERE trip_id = $1)
       ORDER BY created_at, id`,
      [tripId],
    );
    return this.withGrants(result.rows);
  }

  async putAgent(agent: AgentRecord) {
    await this.sql.query(
      `INSERT INTO agents (${AGENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, credential_hash = EXCLUDED.credential_hash, oauth_issuer = EXCLUDED.oauth_issuer,
           oauth_subject = EXCLUDED.oauth_subject, revoked_at = EXCLUDED.revoked_at`,
      [
        agent.id,
        agent.name,
        agent.credentialHash,
        agent.oauth?.issuer ?? null,
        agent.oauth?.subject ?? null,
        agent.createdAt,
        agent.revokedAt,
      ],
    );
    await this.sql.query("DELETE FROM agent_grants WHERE agent_id = $1", [agent.id]);
    for (const grant of agent.grants) {
      await this.sql.query("INSERT INTO agent_grants (agent_id, trip_id, scopes) VALUES ($1, $2, $3::jsonb)", [
        agent.id,
        grant.tripId,
        json(grant.scopes),
      ]);
    }
  }
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  readonly durable = true;

  private constructor(
    private readonly db: SqlDatabase,
    readonly scope: DataScope,
    private readonly retry: RetryOptions,
  ) {}

  /**
   * Checks that the database is usable before anything reads or writes it:
   * its schema version must be one this code accepts, and it must carry an
   * environment marker. The marker becomes the store's `scope`, which the
   * caller compares with the deployment.
   *
   * The accepted list can include a version newer than the code needs, once
   * that version has been reviewed as compatible. That lets a migration be
   * applied while the previous code is still serving, before the code that
   * needs it is deployed (see AGENTS.md and docs/storage.md).
   */
  static async open(db: SqlDatabase, retry: Partial<RetryOptions> = {}): Promise<PostgresStore> {
    const version = await currentSchemaVersion(db);
    if (version === 0) throw new StoreUnavailableError("schema_missing");
    if (!ACCEPTED_SCHEMA_VERSIONS.includes(version)) {
      const behind = version < Math.min(...ACCEPTED_SCHEMA_VERSIONS);
      throw new StoreUnavailableError(behind ? "schema_behind" : "schema_unknown");
    }
    const scope = await readDataScope(db);
    if (scope === null) throw new StoreUnavailableError("scope_marker_missing");
    return new PostgresStore(db, scope, { ...DEFAULT_RETRY, ...retry });
  }

  /**
   * One SERIALIZABLE transaction. If Postgres reports a collision with a
   * concurrent transaction, everything was rolled back, so `fn` runs again
   * from the start after a short, growing, randomized wait.
   */
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction((sql) => fn(new PostgresTx(sql)));
      } catch (error) {
        const state = sqlState(error);
        if (state === null || !RETRYABLE_STATES.has(state) || attempt >= this.retry.maxAttempts) throw error;
        const ceiling = this.retry.baseDelayMs * 2 ** (attempt - 1);
        await this.retry.sleep(Math.ceil(ceiling * (0.5 + this.retry.random() / 2)));
      }
    }
  }

  /**
   * Durable fixed-window counter. The increment is a single atomic statement,
   * so it counts correctly across every server instance.
   */
  /**
   * Read fresh, so a long-lived server instance reports a migration as soon
   * as it runs. The database itself stops the query after 3 seconds
   * (`SET LOCAL` lasts only for this transaction), so a stuck read cannot
   * keep holding one of the pool's few connections.
   */
  readSchemaVersion(): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '3s'");
      return currentSchemaVersion(tx);
    });
  }

  async hitRateLimit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult> {
    const nowMs = now.getTime();
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const result = await this.db.query<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [key, new Date(windowStart).toISOString()],
    );
    const count = Number(result.rows[0].count);
    if (count === 1) {
      // A new window just opened: a cheap moment to drop windows nobody will read again.
      await this.db.query("DELETE FROM rate_limits WHERE window_start < $1", [
        new Date(nowMs - RATE_LIMIT_RETENTION_MS).toISOString(),
      ]);
    }
    if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
    };
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
