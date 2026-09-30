// One contract, two stores. Every test here runs against the in-memory
// fixture and against the Postgres store (on an in-process Postgres), so the
// two cannot drift apart.

import { describe, expect, it } from "vitest";
import { MemoryFixtureStore } from "@/server/store/memory";
import { PostgresStore } from "@/server/store/postgres";
import { StaleWriteError, type AgentRecord, type AuditRecord, type ChangeRecord, type Store, type StoredEntity } from "@/server/store/types";
import { cleanSharedDatabase } from "./support/pglite";

const AT = "2031-03-01T12:00:00.000Z";
const LATER = "2031-03-01T12:05:00.000Z";

const BACKENDS: { name: string; create(): Promise<Store> }[] = [
  { name: "memory fixture", create: async () => new MemoryFixtureStore("local") },
  { name: "postgres", create: async () => PostgresStore.open(await cleanSharedDatabase()) },
];

function entity(overrides: Partial<StoredEntity> = {}): StoredEntity {
  return {
    tripId: "trip_a",
    id: "itm_1",
    kind: "packing",
    revision: 1,
    data: { label: "Towel", quantity: 1, packed: false },
    createdAt: AT,
    updatedAt: AT,
    updatedBy: "Tester",
    deletedAt: null,
    ...overrides,
  };
}

function change(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    tripId: "trip_a",
    id: "chg_1",
    batchId: "actor.2031-03-01",
    entityId: "itm_1",
    kind: "packing",
    action: "create",
    before: null,
    resultRevision: 1,
    at: AT,
    actorId: "actor",
    ...overrides,
  };
}

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    tripId: "trip_a",
    id: "aud_1",
    at: AT,
    actorType: "web",
    actorId: "actor",
    actorLabel: "Actor",
    op: "add_item",
    kind: "packing",
    entityId: "itm_1",
    batchId: "actor.2031-03-01",
    changeId: "chg_1",
    outcome: "ok",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_1",
    name: "Agent one",
    grants: [{ tripId: "trip_a", scopes: ["trip:read", "packing:write"] }],
    credentialHash: "hash-one",
    oauth: null,
    createdAt: AT,
    revokedAt: null,
    ...overrides,
  };
}

describe.each(BACKENDS)("store contract: $name", ({ create }) => {
  it("stores and returns a record exactly, including nested data and timestamps", async () => {
    const store = await create();
    const record = entity({ data: { label: "Towel", quantity: 2, packed: true, nested: { a: [1, "two", null] } }, deletedAt: LATER });
    await store.transaction((tx) => tx.putEntity(record));
    expect(await store.transaction((tx) => tx.getEntity("trip_a", "itm_1"))).toEqual(record);
    expect(await store.transaction((tx) => tx.getEntity("trip_a", "missing"))).toBeNull();
  });

  it("never returns one trip's record for another trip", async () => {
    const store = await create();
    await store.transaction(async (tx) => {
      await tx.putEntity(entity({ tripId: "trip_a", id: "same_id" }));
      await tx.putEntity(entity({ tripId: "trip_b", id: "same_id", data: { label: "Other trip", quantity: 1, packed: false } }));
      await tx.putEntity(entity({ tripId: "trip_b", id: "only_b" }));
    });
    await store.transaction(async (tx) => {
      expect((await tx.getEntity("trip_a", "same_id"))?.data.label).toBe("Towel");
      expect((await tx.getEntity("trip_b", "same_id"))?.data.label).toBe("Other trip");
      expect(await tx.getEntity("trip_a", "only_b")).toBeNull();
      expect((await tx.listEntities("trip_a", "packing")).map((e) => e.id)).toEqual(["same_id"]);
      expect((await tx.listEntities("trip_b", "packing")).map((e) => e.id).sort()).toEqual(["only_b", "same_id"]);
    });
  });

  it("lists by kind and hides removed records unless asked", async () => {
    const store = await create();
    await store.transaction(async (tx) => {
      await tx.putEntity(entity({ id: "live" }));
      await tx.putEntity(entity({ id: "gone", deletedAt: LATER }));
      await tx.putEntity(entity({ id: "note", kind: "notes", data: { title: "n", body: "" } }));
    });
    await store.transaction(async (tx) => {
      expect((await tx.listEntities("trip_a", "packing")).map((e) => e.id)).toEqual(["live"]);
      expect((await tx.listEntities("trip_a", "packing", { includeDeleted: true })).map((e) => e.id).sort()).toEqual(["gone", "live"]);
      expect((await tx.listEntities("trip_a", "notes")).map((e) => e.id)).toEqual(["note"]);
    });
  });

  it("accepts only the next revision of a record", async () => {
    const store = await create();
    await store.transaction((tx) => tx.putEntity(entity()));
    await store.transaction((tx) => tx.putEntity(entity({ revision: 2, updatedAt: LATER })));
    const stale = [
      entity({ revision: 1 }), // creating it again
      entity({ revision: 2 }), // repeating a revision
      entity({ revision: 4 }), // skipping one
      entity({ id: "brand_new", revision: 2 }), // a new record that does not start at 1
    ];
    for (const write of stale) {
      await expect(store.transaction((tx) => tx.putEntity(write))).rejects.toBeInstanceOf(StaleWriteError);
    }
    expect((await store.transaction((tx) => tx.getEntity("trip_a", "itm_1")))?.revision).toBe(2);
    expect(await store.transaction((tx) => tx.getEntity("trip_a", "brand_new"))).toBeNull();
  });

  it("keeps none of a transaction's writes when it throws", async () => {
    const store = await create();
    await store.transaction((tx) => tx.putEntity(entity()));
    await expect(
      store.transaction(async (tx) => {
        await tx.putEntity(entity({ revision: 2, data: { label: "Changed", quantity: 1, packed: true } }));
        await tx.putEntity(entity({ id: "second" }));
        await tx.appendChange(change());
        await tx.appendAudit(audit());
        await tx.setSessionEpoch("trip_a", 9);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.transaction(async (tx) => {
      expect((await tx.getEntity("trip_a", "itm_1"))?.revision).toBe(1);
      expect(await tx.getEntity("trip_a", "second")).toBeNull();
      expect(await tx.getChange("trip_a", "chg_1")).toBeNull();
      expect(await tx.listAudit("trip_a", { limit: 10 })).toEqual([]);
      expect(await tx.getSessionEpoch("trip_a")).toBe(0);
    });
  });

  it("runs simultaneous transactions without losing a write", async () => {
    const store = await create();
    await store.transaction((tx) => tx.setSessionEpoch("trip_a", 0));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.transaction(async (tx) => tx.setSessionEpoch("trip_a", (await tx.getSessionEpoch("trip_a")) + 1)),
      ),
    );
    expect(await store.transaction((tx) => tx.getSessionEpoch("trip_a"))).toBe(20);
  });

  it("keeps change history in order, with full snapshots, per trip and batch", async () => {
    const store = await create();
    const before = entity();
    await store.transaction(async (tx) => {
      await tx.appendChange(change({ id: "chg_1" }));
      await tx.appendChange(change({ id: "chg_2", action: "update", before, resultRevision: 2 }));
      await tx.appendChange(change({ id: "chg_3", batchId: "other.2031-03-01" }));
      await tx.appendChange(change({ id: "chg_4", tripId: "trip_b" }));
    });
    await store.transaction(async (tx) => {
      expect((await tx.listChangesByBatch("trip_a", "actor.2031-03-01")).map((c) => c.id)).toEqual(["chg_1", "chg_2"]);
      expect(await tx.getChange("trip_a", "chg_2")).toEqual(change({ id: "chg_2", action: "update", before, resultRevision: 2 }));
      expect(await tx.getChange("trip_a", "chg_4")).toBeNull();
      expect((await tx.listChangesByBatch("trip_b", "actor.2031-03-01")).map((c) => c.id)).toEqual(["chg_4"]);
    });
  });

  it("returns the audit log newest first, filtered and limited", async () => {
    const store = await create();
    await store.transaction(async (tx) => {
      await tx.appendAudit(audit({ id: "aud_1" }));
      await tx.appendAudit(audit({ id: "aud_2", kind: "notes", batchId: "other.2031-03-01" }));
      await tx.appendAudit(audit({ id: "aud_3", kind: null, entityId: null, changeId: null, batchId: null, op: "sign_in" }));
      await tx.appendAudit(audit({ id: "aud_4", tripId: "trip_b" }));
    });
    await store.transaction(async (tx) => {
      expect((await tx.listAudit("trip_a", { limit: 10 })).map((e) => e.id)).toEqual(["aud_3", "aud_2", "aud_1"]);
      expect((await tx.listAudit("trip_a", { limit: 2 })).map((e) => e.id)).toEqual(["aud_3", "aud_2"]);
      expect((await tx.listAudit("trip_a", { limit: 10, kinds: ["packing"] })).map((e) => e.id)).toEqual(["aud_1"]);
      expect((await tx.listAudit("trip_a", { limit: 10, kinds: ["packing", "notes"] })).map((e) => e.id)).toEqual(["aud_2", "aud_1"]);
      expect(await tx.listAudit("trip_a", { limit: 10, kinds: [] })).toEqual([]);
      expect((await tx.listAudit("trip_a", { limit: 10, batchId: "other.2031-03-01" })).map((e) => e.id)).toEqual(["aud_2"]);
      expect((await tx.listAudit("trip_a", { limit: 10 }))[2]).toEqual(audit({ id: "aud_1" }));
      expect((await tx.listAudit("trip_b", { limit: 10 })).map((e) => e.id)).toEqual(["aud_4"]);
    });
  });

  it("keeps idempotency records per trip and actor", async () => {
    const store = await create();
    const record = { tripId: "trip_a", principalId: "actor", key: "key-0001", requestHash: "h", result: { status: "ok", n: 1 }, at: AT };
    await store.transaction((tx) => tx.putIdempotency(record));
    await store.transaction(async (tx) => {
      expect(await tx.getIdempotency("trip_a", "actor", "key-0001")).toEqual(record);
      expect(await tx.getIdempotency("trip_a", "someone_else", "key-0001")).toBeNull();
      expect(await tx.getIdempotency("trip_b", "actor", "key-0001")).toBeNull();
    });
  });

  it("stores sessions, their revocation, and the per-trip epoch", async () => {
    const store = await create();
    const session = { id: "sess_1", tripId: "trip_a", label: "Phone", createdAt: AT, expiresAt: LATER, revokedAt: null, epoch: 0 };
    await store.transaction((tx) => tx.putSession(session));
    expect(await store.transaction((tx) => tx.getSession("sess_1"))).toEqual(session);
    await store.transaction((tx) => tx.putSession({ ...session, revokedAt: LATER }));
    expect((await store.transaction((tx) => tx.getSession("sess_1")))?.revokedAt).toBe(LATER);
    expect(await store.transaction((tx) => tx.getSession("missing"))).toBeNull();

    await store.transaction((tx) => tx.setSessionEpoch("trip_a", 3));
    await store.transaction(async (tx) => {
      expect(await tx.getSessionEpoch("trip_a")).toBe(3);
      expect(await tx.getSessionEpoch("trip_b")).toBe(0);
    });
  });

  it("finds agents by id, credential hash and OAuth identity, and lists them per trip", async () => {
    const store = await create();
    const oauthAgent = agent({
      id: "agent_2",
      name: "OAuth agent",
      credentialHash: null,
      oauth: { issuer: "https://issuer.example", subject: "client-1|user-1" },
      grants: [{ tripId: "trip_b", scopes: ["trip:read"] }],
    });
    await store.transaction(async (tx) => {
      await tx.putAgent(agent());
      await tx.putAgent(oauthAgent);
    });
    await store.transaction(async (tx) => {
      expect(await tx.getAgent("agent_1")).toEqual(agent());
      expect(await tx.getAgentByCredentialHash("hash-one")).toEqual(agent());
      expect(await tx.getAgentByCredentialHash("nope")).toBeNull();
      expect(await tx.getAgentByOAuthIdentity({ issuer: "https://issuer.example", subject: "client-1|user-1" })).toEqual(oauthAgent);
      expect(await tx.getAgentByOAuthIdentity({ issuer: "https://other.example", subject: "client-1|user-1" })).toBeNull();
      expect(await tx.getAgentByOAuthIdentity({ issuer: "https://issuer.example", subject: "client-2|user-1" })).toBeNull();
      expect((await tx.listAgents("trip_a")).map((a) => a.id)).toEqual(["agent_1"]);
      expect((await tx.listAgents("trip_b")).map((a) => a.id)).toEqual(["agent_2"]);
    });
  });

  it("replaces an agent's grants and records revocation", async () => {
    const store = await create();
    await store.transaction((tx) => tx.putAgent(agent()));
    await store.transaction((tx) =>
      tx.putAgent(agent({ grants: [{ tripId: "trip_a", scopes: ["packing:read"] }, { tripId: "trip_b", scopes: ["trip:read"] }], revokedAt: LATER })),
    );
    const stored = await store.transaction((tx) => tx.getAgent("agent_1"));
    expect(stored?.revokedAt).toBe(LATER);
    expect(stored?.grants).toEqual([
      { tripId: "trip_a", scopes: ["packing:read"] },
      { tripId: "trip_b", scopes: ["trip:read"] },
    ]);
  });

  it("counts rate-limit hits per key and window", async () => {
    const store = await create();
    const t0 = new Date("2031-03-01T12:00:10.000Z");
    for (let i = 0; i < 3; i++) expect((await store.hitRateLimit("k", 3, 60_000, t0)).allowed).toBe(true);
    const blocked = await store.hitRateLimit("k", 3, 60_000, new Date("2031-03-01T12:00:40.000Z"));
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 20 });
    expect((await store.hitRateLimit("other", 3, 60_000, t0)).allowed).toBe(true);
    expect((await store.hitRateLimit("k", 3, 60_000, new Date("2031-03-01T12:01:00.000Z"))).allowed).toBe(true);
  });

  it("counts simultaneous hits exactly", async () => {
    const store = await create();
    const now = new Date("2031-03-01T12:00:00.000Z");
    const results = await Promise.all(Array.from({ length: 25 }, () => store.hitRateLimit("burst", 10, 60_000, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
  });
});
