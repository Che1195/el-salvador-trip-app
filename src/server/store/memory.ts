// LOCAL DEVELOPMENT FIXTURE. This store keeps everything in one process's
// memory: data disappears on restart and is not shared between devices or
// server instances. It exists so the app and its tests run without a
// database. `selectStorage` in ../config.ts refuses to use it in production.

import type { EntityKind } from "@/domain/model";
import type {
  AgentRecord,
  AuditQuery,
  AuditRecord,
  ChangeRecord,
  DataScope,
  IdempotencyRecord,
  RateLimitResult,
  SessionRecord,
  Store,
  StoredEntity,
  StoreTx,
} from "./types";

interface State {
  entities: Map<string, StoredEntity>;
  changes: ChangeRecord[];
  audit: AuditRecord[];
  idempotency: Map<string, IdempotencyRecord>;
  sessions: Map<string, SessionRecord>;
  sessionEpochs: Map<string, number>;
  agents: Map<string, AgentRecord>;
}

const MAX_AUDIT_ENTRIES = 5000;
const MAX_RATE_KEYS = 10_000;
const key = (...parts: string[]) => parts.join("\u0000");
const copy = <T>(value: T): T => structuredClone(value);

class MemoryTx implements StoreTx {
  constructor(private readonly state: State) {}

  async getEntity(tripId: string, id: string) {
    const found = this.state.entities.get(key(tripId, id));
    return found ? copy(found) : null;
  }

  async listEntities(tripId: string, kind: EntityKind, options?: { includeDeleted?: boolean }) {
    const out: StoredEntity[] = [];
    for (const entity of this.state.entities.values()) {
      if (entity.tripId !== tripId || entity.kind !== kind) continue;
      if (entity.deletedAt !== null && !options?.includeDeleted) continue;
      out.push(copy(entity));
    }
    return out;
  }

  async putEntity(entity: StoredEntity) {
    this.state.entities.set(key(entity.tripId, entity.id), copy(entity));
  }

  async appendChange(change: ChangeRecord) {
    this.state.changes.push(copy(change));
  }

  async getChange(tripId: string, id: string) {
    const found = this.state.changes.find((c) => c.tripId === tripId && c.id === id);
    return found ? copy(found) : null;
  }

  async listChangesByBatch(tripId: string, batchId: string) {
    return this.state.changes
      .filter((c) => c.tripId === tripId && c.batchId === batchId)
      .map(copy);
  }

  async appendAudit(entry: AuditRecord) {
    this.state.audit.push(copy(entry));
    if (this.state.audit.length > MAX_AUDIT_ENTRIES) {
      this.state.audit.splice(0, this.state.audit.length - MAX_AUDIT_ENTRIES);
    }
  }

  async listAudit(tripId: string, query: AuditQuery) {
    const out: AuditRecord[] = [];
    for (let i = this.state.audit.length - 1; i >= 0 && out.length < query.limit; i--) {
      const entry = this.state.audit[i];
      if (entry.tripId !== tripId) continue;
      if (query.batchId !== undefined && entry.batchId !== query.batchId) continue;
      if (query.kinds && (entry.kind === null || !query.kinds.includes(entry.kind))) continue;
      out.push(copy(entry));
    }
    return out;
  }

  async getIdempotency(tripId: string, principalId: string, idempotencyKey: string) {
    const found = this.state.idempotency.get(key(tripId, principalId, idempotencyKey));
    return found ? copy(found) : null;
  }

  async putIdempotency(record: IdempotencyRecord) {
    this.state.idempotency.set(key(record.tripId, record.principalId, record.key), copy(record));
  }

  async getSession(id: string) {
    const found = this.state.sessions.get(id);
    return found ? copy(found) : null;
  }

  async putSession(session: SessionRecord) {
    this.state.sessions.set(session.id, copy(session));
  }

  async getSessionEpoch(tripId: string) {
    return this.state.sessionEpochs.get(tripId) ?? 0;
  }

  async setSessionEpoch(tripId: string, epoch: number) {
    this.state.sessionEpochs.set(tripId, epoch);
  }

  async getAgent(id: string) {
    const found = this.state.agents.get(id);
    return found ? copy(found) : null;
  }

  async getAgentByCredentialHash(hash: string) {
    for (const agent of this.state.agents.values()) {
      if (agent.credentialHash !== null && agent.credentialHash === hash) return copy(agent);
    }
    return null;
  }

  async listAgents(tripId: string) {
    return [...this.state.agents.values()]
      .filter((agent) => agent.grants.some((grant) => grant.tripId === tripId))
      .map(copy);
  }

  async putAgent(agent: AgentRecord) {
    this.state.agents.set(agent.id, copy(agent));
  }
}

export class MemoryFixtureStore implements Store {
  readonly kind = "memory-fixture" as const;
  readonly durable = false;

  private state: State = {
    entities: new Map(),
    changes: [],
    audit: [],
    idempotency: new Map(),
    sessions: new Map(),
    sessionEpochs: new Map(),
    agents: new Map(),
  };
  private tail: Promise<unknown> = Promise.resolve();
  private readonly rateWindows = new Map<string, { windowStart: number; count: number }>();

  constructor(readonly scope: DataScope) {
    if (scope === "production") {
      throw new Error("The in-memory fixture store must never hold production data.");
    }
  }

  /**
   * Transactions run one at a time against a private copy of the state, which
   * replaces the shared state only if `fn` succeeds. That gives the same
   * all-or-nothing, serialized behavior the domain expects from Postgres.
   */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const draft = copy(this.state);
      const result = await fn(new MemoryTx(draft));
      this.state = draft;
      return result;
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async hitRateLimit(
    limitKey: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<RateLimitResult> {
    const nowMs = now.getTime();
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const current = this.rateWindows.get(limitKey);
    const count = current && current.windowStart === windowStart ? current.count + 1 : 1;
    this.rateWindows.set(limitKey, { windowStart, count });
    if (this.rateWindows.size > MAX_RATE_KEYS) {
      // Drop the oldest keys; insertion order makes those the first entries.
      for (const stale of this.rateWindows.keys()) {
        if (this.rateWindows.size <= MAX_RATE_KEYS / 2) break;
        this.rateWindows.delete(stale);
      }
    }
    if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
    };
  }
}
