// Storage contract shared by the local fixture and the future Postgres store.
//
// Trip-scoping invariant: every method that touches trip content takes the
// trip id as an explicit argument and must filter on it. Nothing here infers
// the trip from ambient state, and a record of one trip is never returned for
// another.

import type {
  ActivityEntry,
  ChangeAction,
  EntityKind,
  Scope,
  StorageKind,
} from "@/domain/model";

export type JsonObject = Record<string, unknown>;

/** Which data a store holds. A deployment only talks to a store of its own scope. */
export type DataScope = "local" | "preview" | "production";

export interface StoredEntity {
  tripId: string;
  id: string;
  kind: EntityKind;
  revision: number;
  data: JsonObject;
  createdAt: string;
  updatedAt: string;
  /** Display label of whoever saved this revision. */
  updatedBy: string;
  deletedAt: string | null;
}

/**
 * One state transition of one record. `before` is the full prior record (null
 * when the change created it), which is what makes every change reversible.
 */
export interface ChangeRecord {
  tripId: string;
  id: string;
  batchId: string;
  entityId: string;
  kind: EntityKind;
  action: ChangeAction;
  before: StoredEntity | null;
  /** Revision the record had right after this change. */
  resultRevision: number;
  at: string;
  actorId: string;
}

export interface AuditRecord extends ActivityEntry {
  tripId: string;
}

export interface IdempotencyRecord {
  tripId: string;
  principalId: string;
  key: string;
  requestHash: string;
  result: JsonObject;
  at: string;
}

export interface SessionRecord {
  id: string;
  tripId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Value of the trip's session epoch when this session was created. */
  epoch: number;
}

export interface AgentGrant {
  tripId: string;
  scopes: Scope[];
}

/** Who an OAuth authorization server says the caller is. */
export interface OAuthIdentity {
  issuer: string;
  subject: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  grants: AgentGrant[];
  /** SHA-256 of the agent's credential. The credential itself is never stored. */
  credentialHash: string | null;
  /** Set for agents that sign in through an OAuth authorization server. */
  oauth: OAuthIdentity | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuditQuery {
  limit: number;
  batchId?: string;
  kinds?: readonly EntityKind[];
}

export interface StoreTx {
  getEntity(tripId: string, id: string): Promise<StoredEntity | null>;
  listEntities(
    tripId: string,
    kind: EntityKind,
    options?: { includeDeleted?: boolean },
  ): Promise<StoredEntity[]>;
  /**
   * Inserts a record at revision 1, or replaces the stored record with its
   * next revision. Anything else (a skipped or repeated revision) throws
   * StaleWriteError: it means a write was based on an outdated read.
   */
  putEntity(entity: StoredEntity): Promise<void>;

  appendChange(change: ChangeRecord): Promise<void>;
  getChange(tripId: string, id: string): Promise<ChangeRecord | null>;
  /** Oldest first. */
  listChangesByBatch(tripId: string, batchId: string): Promise<ChangeRecord[]>;

  appendAudit(entry: AuditRecord): Promise<void>;
  /** Newest first. */
  listAudit(tripId: string, query: AuditQuery): Promise<AuditRecord[]>;

  getIdempotency(tripId: string, principalId: string, key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;

  getSession(id: string): Promise<SessionRecord | null>;
  putSession(session: SessionRecord): Promise<void>;
  getSessionEpoch(tripId: string): Promise<number>;
  setSessionEpoch(tripId: string, epoch: number): Promise<void>;

  getAgent(id: string): Promise<AgentRecord | null>;
  getAgentByCredentialHash(hash: string): Promise<AgentRecord | null>;
  getAgentByOAuthIdentity(identity: OAuthIdentity): Promise<AgentRecord | null>;
  listAgents(tripId: string): Promise<AgentRecord[]>;
  putAgent(agent: AgentRecord): Promise<void>;
}

/** A write whose revision does not follow the stored one. Never expected; a last line of defense. */
export class StaleWriteError extends Error {
  constructor(entityId: string) {
    super(`stale write refused for ${entityId}`);
    this.name = "StaleWriteError";
  }
}

export interface Store {
  readonly kind: StorageKind;
  /** False for the in-memory fixture: its data is lost on restart and not shared. */
  readonly durable: boolean;
  /** The database's schema version, or null for a store without one (the fixture). */
  readonly schemaVersion: number | null;
  readonly scope: DataScope;

  /**
   * Runs `fn` atomically and in isolation from other transactions. If `fn`
   * throws, none of its writes are kept.
   */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;

  /** Counts one hit against a fixed window and reports whether it is within the limit. */
  hitRateLimit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult>;
}
