// Per-agent keys: a signed-in person creates an agent in the app and receives
// a key once; the server keeps only its SHA-256. These tests run on the
// in-memory fixture and, in the "postgres" test project, on an in-process
// Postgres. Most use a production configuration (no sample data, no local
// shortcuts) over a store that reports scope "production".
//
// What is not shown here: PGlite runs transactions one at a time, so the
// "simultaneous" cases prove the rules hold when requests overlap, not that a
// real Postgres server resolves true write collisions. That stays unverified.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Scope } from "@/domain/model";
import { createKeyAgentAuthenticator } from "@/server/agent-auth";
import { LOCAL_FIXTURE_PASSWORD } from "@/server/config";
import { buildDeps } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { handleHealth, handleOperation } from "@/server/handlers";
import { sha256Hex } from "@/server/hash";
import { handleMcpRequest } from "@/server/mcp/handler";
import { handleProtectedResourceMetadata } from "@/server/oauth/metadata";
import { executeOperation, operationsForAgent } from "@/server/operations";
import type { AgentRecord, Store, StoreTx } from "@/server/store/types";
import {
  agentPrincipal,
  ctxFor,
  key as idempotencyKey,
  makeHarness,
  makeProductionHarness,
  makeRequest,
  ORIGIN,
  signIn,
  webPrincipal,
  type Harness,
} from "./support/harness";

const MCP_URL = `${ORIGIN}/api/mcp`;
const KEY_SHAPE = /^tpk_[A-Za-z0-9_-]{43}$/;
const SENTINEL = "PRIVATE-SENTINEL-TEXT";
const ALL_SCOPES: Scope[] = ["trip:read", "trip:write", "packing:read", "packing:write"];
const PRODUCTION_ENV = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" };

type Preset = "full" | "packing" | "read";

interface Created {
  status: string;
  agent: AgentSummary;
  key: string;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const web = (h: Harness) => ctxFor(h, webPrincipal(h));

async function create(h: Harness, name: string, preset: Preset = "full"): Promise<Created> {
  return (await executeOperation(web(h), "create_agent", { name, preset, confirm: true })) as unknown as Created;
}

/** The error code an operation was refused with, or "ok" / "other". */
async function outcomeOf(attempt: Promise<unknown>): Promise<string> {
  return attempt.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
}

async function listAgents(h: Harness): Promise<AgentSummary[]> {
  return (await executeOperation(web(h), "list_agents", {})).agents as AgentSummary[];
}

const activeCount = async (h: Harness) => (await listAgents(h)).filter((a) => a.revokedAt === null).length;

function initializeRequest(headers: Record<string, string> | Headers = {}, url = MCP_URL): Request {
  const merged = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
  new Headers(headers).forEach((value, name) => merged.set(name, value));
  return new Request(url, {
    method: "POST",
    headers: merged,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function statusOf(h: Harness, request: Request): Promise<number> {
  return (await handleMcpRequest(request, h.deps)).status;
}

async function connect(h: Harness, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init), h.deps),
    requestInit: { headers: bearer(token) },
  });
  const client = new Client({ name: "agent-key-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

/** A request the store cannot serve: every listed method throws the sentinel. */
function storeThatThrows(h: Harness, methods: ("transaction" | "hitRateLimit")[]): Store {
  const failures = Object.fromEntries(
    methods.map((method) => [
      method,
      {
        value: async () => {
          throw new Error(`database said ${SENTINEL}`);
        },
      },
    ]),
  );
  return Object.create(h.store, failures) as Store;
}

/** A store whose transactions hand the callback a transaction with some methods replaced. */
function storeWithTx(h: Harness, replace: (tx: StoreTx) => PropertyDescriptorMap): Store {
  return Object.create(h.store, {
    transaction: {
      value: <T>(fn: (tx: StoreTx) => Promise<T>) => h.store.transaction((tx) => fn(Object.create(tx, replace(tx)) as StoreTx)),
    },
  }) as Store;
}

describe("creating an agent", () => {
  it("returns a tpk_ key of 47 characters that works on /api/mcp in a production configuration", async () => {
    const h = await makeProductionHarness();
    expect(h.deps.config.deployment).toBe("production");
    expect(h.store.scope).toBe("production");

    const created = await create(h, "Melo", "full");
    expect(created.status).toBe("ok");
    expect(created.key).toMatch(KEY_SHAPE);
    expect(created.key).toHaveLength(47);
    expect(created.agent).toMatchObject({ name: "Melo", scopes: ALL_SCOPES, revokedAt: null });
    expect(created.agent.id).toMatch(/^agent_[0-9a-f]{32}$/);

    const client = await connect(h, created.key);
    expect((await toolNames(client)).length).toBeGreaterThan(0);
    expect((await callTool(client, "get_packing_list", {})).structuredContent).toMatchObject({ totalCount: 0 });
    const added = await callTool(client, "add_item", {
      section: "packing",
      data: { label: "Headlamp", quantity: 1, packed: false },
      idempotencyKey: idempotencyKey(),
    });
    expect(added.structuredContent).toMatchObject({ status: "ok", changed: true });
    // The change is attributed to the agent by the name it was given.
    const changes = (await executeOperation(web(h), "list_changes", {})).entries as Record<string, unknown>[];
    expect(changes[0]).toMatchObject({ actorType: "agent", actorId: created.agent.id, actorLabel: "Melo", op: "add_item" });
  });

  it("makes every key different", async () => {
    const h = await makeProductionHarness();
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) keys.add((await create(h, `Agent ${i}`)).key);
    expect(keys.size).toBe(5);
  });

  it("stores only the key's SHA-256", async () => {
    const h = await makeProductionHarness();
    const created = await create(h, "Melo");
    const stored = await h.store.transaction((tx) => tx.getAgent(created.agent.id));
    expect(stored?.credentialHash).toBe(sha256Hex(created.key));
    expect(stored?.oauth).toBeNull();
    expect(stored?.grants).toEqual([{ tripId: h.tripId, scopes: ALL_SCOPES }]);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    const byHash = await h.store.transaction((tx) => tx.getAgentByCredentialHash(sha256Hex(created.key)));
    expect(byHash?.id).toBe(created.agent.id);
  });

  it("never returns or stores the key or its hash again", async () => {
    const h = await makeProductionHarness();
    const created = await create(h, "Melo");
    const hash = sha256Hex(created.key);
    const client = await connect(h, created.key);
    await callTool(client, "add_item", {
      section: "packing",
      data: { label: "Headlamp", quantity: 1, packed: false },
      idempotencyKey: idempotencyKey(),
    });

    const everything = JSON.stringify([
      await executeOperation(web(h), "list_agents", {}),
      await executeOperation(web(h), "list_changes", {}),
      await h.store.transaction((tx) => tx.listAudit(h.tripId, { limit: 500 })),
      await h.store.transaction((tx) => tx.listAgents(h.tripId).then((agents) => agents.map(({ credentialHash, ...rest }) => (credentialHash === null ? rest : { ...rest, hasHash: true })))),
      await client.listTools(),
      await callTool(client, "get_packing_list", {}),
      await callTool(client, "list_changes", {}),
    ]);
    expect(everything).not.toContain(created.key);
    expect(everything).not.toContain(hash);
    expect(everything).not.toContain("credentialHash");
  });

  it("stores no idempotency record for it, and refuses an idempotencyKey outright", async () => {
    const h = await makeProductionHarness();
    const attempt = executeOperation(web(h), "create_agent", {
      name: "Melo",
      preset: "full",
      confirm: true,
      idempotencyKey: "retry-me-12345",
    });
    expect(await outcomeOf(attempt)).toBe("validation_failed");
    expect(await listAgents(h)).toEqual([]);

    const first = await create(h, "Melo");
    // A repeat is a name clash, never a replay that would have to hold the first key.
    expect(await outcomeOf(create(h, "Melo"))).toBe("conflict");
    const principal = webPrincipal(h);
    expect(await h.store.transaction((tx) => tx.getIdempotency(h.tripId, principal.id, "retry-me-12345"))).toBeNull();
    expect((await listAgents(h)).map((agent) => agent.id)).toEqual([first.agent.id]);
  });

  it("writes an audit line with the agent id and outcome only", async () => {
    const h = await makeProductionHarness();
    const created = await create(h, "Melo");
    const audit = await h.store.transaction((tx) => tx.listAudit(h.tripId, { limit: 50 }));
    const lines = audit.filter((entry) => entry.op === "create_agent");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actorType: "web",
      actorId: webPrincipal(h).id,
      entityId: created.agent.id,
      outcome: "ok",
      kind: null,
      changeId: null,
    });
    expect(JSON.stringify(lines)).not.toContain("Melo");
  });

  it("is a person-only operation: agents are not offered it and cannot call it", async () => {
    const h = await makeProductionHarness();
    const created = await create(h, "Melo");
    const client = await connect(h, created.key);
    expect(await toolNames(client)).not.toContain("create_agent");
    const viaProtocol = await callTool(client, "create_agent", { name: "Sneaky", preset: "full", confirm: true }).then(
      (result) => result.isError === true,
      () => true,
    );
    expect(viaProtocol).toBe(true);

    const asAgent = { ...web(h), principal: agentPrincipal(h, ALL_SCOPES) };
    expect(await outcomeOf(executeOperation(asAgent, "create_agent", { name: "Sneaky", preset: "full", confirm: true }))).toBe("forbidden");
    expect((await listAgents(h)).map((agent) => agent.name)).toEqual(["Melo"]);
    expect(operationsForAgent(ALL_SCOPES).map((op) => op.name)).not.toContain("create_agent");
  });

  it("works from the app's own route, once, with nothing cached", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const post = (body: unknown, withCookie: string | null = cookie) =>
      handleOperation(makeRequest("/api/trip/ops", { method: "POST", cookie: withCookie, body }), h.deps);
    const input = { name: "Melo", preset: "packing", confirm: true };

    const response = await post({ op: "create_agent", input });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as Created;
    expect(body.key).toMatch(KEY_SHAPE);
    expect((await handleMcpRequest(initializeRequest(bearer(body.key)), h.deps)).status).toBe(200);

    expect((await post({ op: "create_agent", input })).status).toBe(409);
    expect((await post({ op: "create_agent", input: { name: "Other", preset: "full" } })).status).toBe(400);
    expect((await post({ op: "create_agent", input }, null)).status).toBe(401);
    expect(await listAgents(h)).toHaveLength(1);
  });
});

describe("presets", () => {
  it("offers tools that match the preset, and a read-only key cannot change anything", async () => {
    const h = await makeProductionHarness();
    const full = await create(h, "Full agent", "full");
    const packing = await create(h, "Packing agent", "packing");
    const readOnly = await create(h, "Reading agent", "read");
    expect(full.agent.scopes).toEqual(["trip:read", "trip:write", "packing:read", "packing:write"]);
    expect(packing.agent.scopes).toEqual(["packing:read", "packing:write"]);
    expect(readOnly.agent.scopes).toEqual(["trip:read"]);

    const fullNames = await toolNames(await connect(h, full.key));
    expect(fullNames).toEqual(operationsForAgent(full.agent.scopes).map((op) => op.name).sort());
    expect(fullNames).toContain("update_trip");

    const packingClient = await connect(h, packing.key);
    const packingNames = await toolNames(packingClient);
    expect(packingNames).toEqual(operationsForAgent(packing.agent.scopes).map((op) => op.name).sort());
    expect(packingNames).toContain("set_packed");
    expect(packingNames).not.toContain("get_trip");
    expect(packingNames).not.toContain("update_trip");
    const ownList = await callTool(packingClient, "add_item", {
      section: "packing",
      data: { label: "Sunscreen", quantity: 1, packed: false },
      idempotencyKey: idempotencyKey(),
    });
    expect(ownList.structuredContent).toMatchObject({ status: "ok", changed: true });
    const elsewhere = await callTool(packingClient, "add_item", {
      section: "notes",
      data: { title: "x", body: "" },
      idempotencyKey: idempotencyKey(),
    });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.structuredContent).toMatchObject({ error: "insufficient_scope" });

    const readClient = await connect(h, readOnly.key);
    expect(await toolNames(readClient)).toEqual(["get_itinerary", "get_packing_list", "get_trip", "list_changes"]);
    const before = JSON.stringify(await callTool(readClient, "get_packing_list", {}));
    for (const [name, args] of [
      ["add_item", { section: "packing", data: { label: "Nope", quantity: 1, packed: false }, idempotencyKey: idempotencyKey() }],
      ["set_packed", { id: "itm_1", packed: true, expectedRevision: 1, idempotencyKey: idempotencyKey() }],
    ] as const) {
      const refused = await callTool(readClient, name, args).then(
        (result) => result.isError === true,
        () => true,
      );
      expect(refused, name).toBe(true);
    }
    // Even by calling the operation directly, the key's scopes stop every write.
    const asReader = { ...web(h), principal: agentPrincipal(h, readOnly.agent.scopes, readOnly.agent.id) };
    expect(
      await outcomeOf(executeOperation(asReader, "add_item", { section: "packing", data: { label: "Nope", quantity: 1, packed: false }, idempotencyKey: idempotencyKey() })),
    ).toBe("insufficient_scope");
    expect(JSON.stringify(await callTool(readClient, "get_packing_list", {}))).toBe(before);
  });
});

describe("refusals", () => {
  it("refuses a missing or false confirmation", async () => {
    const h = await makeProductionHarness();
    expect(await outcomeOf(executeOperation(web(h), "create_agent", { name: "Melo", preset: "full" }))).toBe("confirmation_required");
    expect(await outcomeOf(executeOperation(web(h), "create_agent", { name: "Melo", preset: "full", confirm: false }))).toBe("confirmation_required");
    expect(await listAgents(h)).toEqual([]);
  });

  it("refuses bad names, bad presets and unknown fields, and creates nothing", async () => {
    const h = await makeProductionHarness();
    const badNames: unknown[] = ["", "   ", "x".repeat(41), "two\nlines", "tab\there", "bell\u0007", "line break", "para break", 7, null, undefined];
    for (const name of badNames) {
      const input = { name, preset: "full", confirm: true };
      expect(await outcomeOf(executeOperation(web(h), "create_agent", input)), JSON.stringify(name)).toBe("validation_failed");
    }
    const badPresets: unknown[] = ["admin", "FULL", "", "trip:write", ["full"], undefined, null];
    for (const preset of badPresets) {
      const input = { name: "Melo", preset, confirm: true };
      expect(await outcomeOf(executeOperation(web(h), "create_agent", input)), JSON.stringify(preset)).toBe("validation_failed");
    }
    for (const extra of [{ scopes: ["trip:write"] }, { idempotencyKey: "abcdefgh12" }, { tripId: "trip_2" }]) {
      const input = { name: "Melo", preset: "read", confirm: true, ...extra };
      expect(await outcomeOf(executeOperation(web(h), "create_agent", input)), JSON.stringify(extra)).toBe("validation_failed");
    }
    expect(await listAgents(h)).toEqual([]);
  });

  it("accepts a 40-character name and trims the edges", async () => {
    const h = await makeProductionHarness();
    const longest = await create(h, "n".repeat(40));
    expect(longest.agent.name).toHaveLength(40);
    const padded = await create(h, "  Grok bot  ");
    expect(padded.agent.name).toBe("Grok bot");
    expect((await listAgents(h)).map((agent) => agent.name).sort()).toEqual(["Grok bot", "n".repeat(40)]);
  });

  it("records a refusal in the audit log by its code, without the key or the name", async () => {
    const h = await makeProductionHarness();
    await create(h, "Melo");
    expect(await outcomeOf(create(h, "melo"))).toBe("conflict");
    const audit = await h.store.transaction((tx) => tx.listAudit(h.tripId, { limit: 50 }));
    const refused = audit.find((entry) => entry.op === "create_agent" && entry.outcome === "conflict");
    expect(refused).toBeDefined();
    expect(refused?.entityId).toBeNull();
  });
});

describe("name and limit rules", () => {
  it("refuses a case-insensitive duplicate of an active agent, but lets a revoked agent's name be reused", async () => {
    const h = await makeProductionHarness();
    const first = await create(h, "Melo");
    expect(await outcomeOf(create(h, "melo"))).toBe("conflict");
    expect(await outcomeOf(create(h, "MELO"))).toBe("conflict");
    expect(await outcomeOf(create(h, " Melo "))).toBe("conflict");
    expect(await activeCount(h)).toBe(1);

    await executeOperation(web(h), "revoke_agent", { agentId: first.agent.id, confirm: true });
    const again = await create(h, "melo");
    expect(again.agent.name).toBe("melo");
    expect(again.key).not.toBe(first.key);
    expect(await activeCount(h)).toBe(1);
    // The old key stays dead; the new one works.
    expect(await statusOf(h, initializeRequest(bearer(first.key)))).toBe(401);
    expect(await statusOf(h, initializeRequest(bearer(again.key)))).toBe(200);
  });

  it("refuses the 26th active agent, while revoked ones do not count", async () => {
    const h = await makeProductionHarness();
    const made: Created[] = [];
    for (let i = 1; i <= 25; i++) made.push(await create(h, `Agent ${i}`));
    expect(await outcomeOf(create(h, "Agent 26"))).toBe("limit_exceeded");
    expect(await activeCount(h)).toBe(25);

    for (const { agent } of made) await executeOperation(web(h), "revoke_agent", { agentId: agent.id, confirm: true });
    expect(await activeCount(h)).toBe(0);
    for (let i = 1; i <= 25; i++) await create(h, `Fresh ${i}`);
    expect(await activeCount(h)).toBe(25);
    expect(await outcomeOf(create(h, "Fresh 26"))).toBe("limit_exceeded");
    expect((await listAgents(h)).length).toBe(50);
  });

  it("counts every active agent on the trip toward the limit, whatever created it", async () => {
    const h = await makeProductionHarness();
    for (let i = 1; i <= 24; i++) await create(h, `Agent ${i}`);
    await h.store.transaction((tx) =>
      tx.putAgent({
        id: "agent_other_route",
        name: "Connected another way",
        grants: [{ tripId: h.tripId, scopes: ["trip:read"] }],
        credentialHash: null,
        oauth: { issuer: "https://issuer.example", subject: "client|user" },
        createdAt: h.now().toISOString(),
        revokedAt: null,
      }),
    );
    expect(await outcomeOf(create(h, "One too many"))).toBe("limit_exceeded");
  });

  it("makes simultaneous creates with the same name produce exactly one agent", async () => {
    const h = await makeProductionHarness();
    const results = await Promise.allSettled([create(h, "Twin"), create(h, "twin"), create(h, "TWIN")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as DomainError).code).toBe("conflict");
    }
    expect(await listAgents(h)).toHaveLength(1);
  });

  it("makes two simultaneous creates with 24 active agents produce exactly one more", async () => {
    const h = await makeProductionHarness();
    for (let i = 1; i <= 24; i++) await create(h, `Agent ${i}`);
    const results = await Promise.allSettled([create(h, "Late A"), create(h, "Late B")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "limit_exceeded" });
    expect(await activeCount(h)).toBe(25);
  });
});

describe("a creation that goes wrong", () => {
  it("leaves no agent, no grant and no audit line when its transaction fails part-way", async () => {
    const h = await makeProductionHarness();
    const failing = storeWithTx(h, () => ({
      appendAudit: {
        value: async () => {
          throw new Error(`audit store said ${SENTINEL}`);
        },
      },
    }));
    const attempt = executeOperation({ ...web(h), store: failing }, "create_agent", { name: "Melo", preset: "full", confirm: true });
    await expect(attempt).rejects.toThrow();

    expect(await h.store.transaction((tx) => tx.listAgents(h.tripId))).toEqual([]);
    const audit = await h.store.transaction((tx) => tx.listAudit(h.tripId, { limit: 50 }));
    expect(audit.filter((entry) => entry.op === "create_agent")).toEqual([]);
    // The name is free again, because nothing was kept.
    expect((await create(h, "Melo")).agent.name).toBe("Melo");
  });

  it("makes a new key when the first one collides, and gives up without keeping an agent after three", async () => {
    const h = await makeProductionHarness();
    const existing = await create(h, "Existing");
    const record = (await h.store.transaction((tx) => tx.getAgent(existing.agent.id))) as AgentRecord;

    let lookups = 0;
    const collideTwice = storeWithTx(h, (tx) => ({
      getAgentByCredentialHash: { value: async (hash: string) => (lookups++ < 2 ? record : tx.getAgentByCredentialHash(hash)) },
    }));
    const made = (await executeOperation({ ...web(h), store: collideTwice }, "create_agent", {
      name: "Second",
      preset: "read",
      confirm: true,
    })) as unknown as Created;
    expect(lookups).toBe(3);
    expect(made.key).toMatch(KEY_SHAPE);
    expect(made.key).not.toBe(existing.key);
    expect(await statusOf(h, initializeRequest(bearer(made.key)))).toBe(200);

    const alwaysCollide = storeWithTx(h, () => ({ getAgentByCredentialHash: { value: async () => record } }));
    await expect(
      executeOperation({ ...web(h), store: alwaysCollide }, "create_agent", { name: "Third", preset: "read", confirm: true }),
    ).rejects.toThrow();
    expect((await listAgents(h)).map((agent) => agent.name).sort()).toEqual(["Existing", "Second"]);
  });
});

describe("revoking", () => {
  it("cuts the key off on its next request, and leaves other agents alone", async () => {
    const h = await makeProductionHarness();
    const first = await create(h, "Melo");
    const second = await create(h, "Jeff");
    const firstClient = await connect(h, first.key);
    expect((await callTool(firstClient, "get_packing_list", {})).isError).toBeFalsy();

    await executeOperation(web(h), "revoke_agent", { agentId: first.agent.id, confirm: true });

    await expect(callTool(firstClient, "get_packing_list", {})).rejects.toThrow();
    const raw = await handleMcpRequest(initializeRequest(bearer(first.key)), h.deps);
    expect(raw.status).toBe(401);
    expect(raw.headers.get("www-authenticate")).toContain("Bearer");
    expect(raw.headers.get("cache-control")).toContain("no-store");
    const secondClient = await connect(h, second.key);
    expect((await callTool(secondClient, "get_packing_list", {})).isError).toBeFalsy();

    const audit = await h.store.transaction((tx) => tx.listAudit(h.tripId, { limit: 50 }));
    expect(audit.find((entry) => entry.op === "revoke_agent")).toMatchObject({ entityId: first.agent.id, outcome: "ok" });
  });
});

describe("agent access can be off", () => {
  it("answers 503 even with a valid key when AGENT_ACCESS=off", async () => {
    const h = await makeProductionHarness();
    const created = await create(h, "Melo");
    expect(await statusOf(h, initializeRequest(bearer(created.key)))).toBe(200);

    const off = await buildDeps({ ...PRODUCTION_ENV, AGENT_ACCESS: "off" }, h.now, async () => h.store);
    expect(off.store).toBe(h.store);
    expect(off.agentAuth.mode).toBe("disabled");
    const response = await handleMcpRequest(initializeRequest(bearer(created.key)), off);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    // Switching it back on needs nothing else: the key was never touched.
    expect(await statusOf(h, initializeRequest(bearer(created.key)))).toBe(200);
  });

  it("answers 503 when no store is connected", async () => {
    const withoutStore = await buildDeps(PRODUCTION_ENV, undefined, async () => null);
    expect(withoutStore.store).toBeNull();
    expect(withoutStore.agentAuth.mode).toBe("disabled");
    const response = await handleMcpRequest(initializeRequest(bearer(`tpk_${randomBytes(32).toString("base64url")}`)), withoutStore);
    expect(response.status).toBe(503);
  });

  it("reports the mode on the health route", async () => {
    const on = await makeProductionHarness();
    expect(((await (await handleHealth(makeRequest("/api/health"), on.deps)).json()) as { agentAccess: string }).agentAccess).toBe("keys");
    const off = await makeHarness({ AGENT_ACCESS: "off" });
    expect(((await (await handleHealth(makeRequest("/api/health"), off.deps)).json()) as { agentAccess: string }).agentAccess).toBe("disabled");
    const none = await buildDeps(PRODUCTION_ENV, undefined, async () => null);
    expect(((await (await handleHealth(makeRequest("/api/health"), none)).json()) as { agentAccess: string }).agentAccess).toBe("disabled");
  });
});

describe("where a key is accepted", () => {
  it("accepts it only in the Authorization header: not in the URL, a cookie, or as the website password", async () => {
    const h = await makeHarness();
    const created = await create(h, "Melo");
    const cookie = await signIn(h);
    const attempts: [string, Request][] = [
      ["key in access_token", initializeRequest({}, `${MCP_URL}?access_token=${created.key}`)],
      ["key in key", initializeRequest({}, `${MCP_URL}?key=${created.key}`)],
      ["key in a cookie", initializeRequest({ Cookie: `trip_session=${created.key}` })],
      ["key in another header", initializeRequest({ "X-Api-Key": created.key })],
      ["a signed-in web session cookie", initializeRequest({ Cookie: cookie })],
      ["the website password as a bearer", initializeRequest(bearer(LOCAL_FIXTURE_PASSWORD))],
    ];
    for (const [label, request] of attempts) {
      const response = await handleMcpRequest(request, h.deps);
      expect(response.status, label).toBe(401);
      expect(response.headers.get("cache-control"), label).toContain("no-store");
    }
    expect(await statusOf(h, initializeRequest(bearer(created.key)))).toBe(200);
  });

  it("refuses a malformed Authorization header with 401", async () => {
    const h = await makeProductionHarness();
    const { key } = await create(h, "Melo");
    const other = (await create(h, "Jeff")).key;
    const twoLines = new Headers();
    twoLines.append("Authorization", `Bearer ${key}`);
    twoLines.append("Authorization", `Bearer ${other}`);
    const attempts: [string, Headers | Record<string, string>][] = [
      ["Basic scheme", { Authorization: `Basic ${key}` }],
      ["lowercase scheme", { Authorization: `bearer ${key}` }],
      ["another scheme", { Authorization: `Token ${key}` }],
      ["no scheme", { Authorization: key }],
      ["scheme only", { Authorization: "Bearer" }],
      ["two spaces", { Authorization: `Bearer  ${key}` }],
      ["trailing words", { Authorization: `Bearer ${key} extra` }],
      ["two values joined by a comma and a space", { Authorization: `Bearer ${key}, Bearer ${other}` }],
      ["two values joined by a comma", { Authorization: `Bearer ${key},${other}` }],
      ["two header lines", twoLines],
      ["a value over 512 characters", { Authorization: `Bearer ${"a".repeat(600)}` }],
      ["a real key with padding past 512", { Authorization: `Bearer ${key}${"a".repeat(470)}` }],
      ["an empty value", { Authorization: "" }],
    ];
    for (const [label, headers] of attempts) {
      const response = await handleMcpRequest(initializeRequest(headers), h.deps);
      expect(response.status, label).toBe(401);
      expect(response.headers.get("www-authenticate"), label).toContain("Bearer");
    }
    expect(await statusOf(h, initializeRequest(bearer(key)))).toBe(200);
  });

  it("answers 403, not 401, for a genuine key with no grant for this trip or an empty grant", async () => {
    const h = await makeProductionHarness();
    const give = async (id: string, grants: AgentRecord["grants"]) => {
      const token = `tpk_${randomBytes(32).toString("base64url")}`;
      await h.store.transaction((tx) =>
        tx.putAgent({ id, name: id, grants, credentialHash: sha256Hex(token), oauth: null, createdAt: h.now().toISOString(), revokedAt: null }),
      );
      return token;
    };
    const otherTrip = await give("agent_other_trip", [{ tripId: "trip_other", scopes: ALL_SCOPES }]);
    const empty = await give("agent_empty_grant", [{ tripId: h.tripId, scopes: [] }]);
    const noGrants = await give("agent_no_grants", []);
    for (const [label, token] of [["other trip", otherTrip], ["empty grant", empty], ["no grants", noGrants]] as const) {
      const response = await handleMcpRequest(initializeRequest(bearer(token)), h.deps);
      expect(response.status, label).toBe(403);
      expect(response.headers.get("cache-control"), label).toContain("no-store");
    }
    // An unknown key is still 401.
    expect(await statusOf(h, initializeRequest(bearer(`tpk_${randomBytes(32).toString("base64url")}`)))).toBe(401);
  });

  it("still applies the origin check, method check and rate limits", async () => {
    const h = await makeProductionHarness();
    const { key } = await create(h, "Melo");
    expect(await statusOf(h, initializeRequest({ ...bearer(key), Origin: "https://evil.example" }))).toBe(403);
    for (const method of ["GET", "DELETE"]) {
      expect(await statusOf(h, new Request(MCP_URL, { method, headers: bearer(key) }))).toBe(405);
    }
    let status = 0;
    for (let i = 0; i < 31; i++) status = await statusOf(h, initializeRequest({ ...bearer("z".repeat(47)) }));
    expect(status).toBe(429);
  });
});

describe("OAuth stays out of it", () => {
  it("is not constructed in key mode: no protected resource, no metadata, a plain challenge", async () => {
    const h = await makeProductionHarness({ MCP_OAUTH_ISSUER: "https://issuer.example", MCP_RESOURCE: `${ORIGIN}/api/mcp` });
    expect(h.deps.agentAuth.mode).toBe("keys");
    expect(h.deps.agentAuth.protectedResource).toBeUndefined();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      expect((await handleProtectedResourceMetadata(makeRequest(path), h.deps)).status, path).toBe(404);
    }
    const refused = await handleMcpRequest(initializeRequest(), h.deps);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe('Bearer realm="trip-planner"');
  });

  it("is built by no source file outside its own module", () => {
    const root = join(process.cwd(), "src");
    const sources = (readdirSync(root, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file));
    const mentions = sources.filter((file) => readFileSync(join(root, file), "utf8").includes("createOAuthAgentAuthenticator"));
    expect(mentions.map((file) => file.replaceAll("\\", "/"))).toEqual(["server/oauth/authenticator.ts"]);
  });
});

describe("the developer token in a deployment", () => {
  it("creates no agent in production or preview, and opens nothing", async () => {
    const token = randomBytes(32).toString("base64url");
    const production = await makeProductionHarness({ MCP_DEV_FIXTURE_TOKEN: token });
    expect(production.deps.config.agentAuth).toEqual({ mode: "keys", localFixtureCredentialHash: null });
    expect(await listAgents(production)).toEqual([]);
    expect(await statusOf(production, initializeRequest(bearer(token)))).toBe(401);

    const preview = await buildDeps({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      NODE_ENV: "production",
      TRIP_FIXTURE_PREVIEW: "1",
      MCP_DEV_FIXTURE_TOKEN: token,
    });
    expect(preview.store).not.toBeNull();
    const previewAgents = await preview.store!.transaction((tx) => tx.listAgents(preview.config.tripId));
    expect(previewAgents).toEqual([]);
    expect((await handleMcpRequest(initializeRequest(bearer(token)), preview)).status).toBe(401);
  });

  it("seeds one agent locally, which a person can still revoke", async () => {
    const token = randomBytes(32).toString("base64url");
    const h = await makeHarness({ MCP_DEV_FIXTURE_TOKEN: token });
    expect(await statusOf(h, initializeRequest(bearer(token)))).toBe(200);
    const [seeded] = await listAgents(h);
    await executeOperation(web(h), "revoke_agent", { agentId: seeded.id, confirm: true });
    expect(await statusOf(h, initializeRequest(bearer(token)))).toBe(401);
  });
});

describe("a failing store behind the endpoint", () => {
  async function expectFixedFailure(response: Response, logged: ReturnType<typeof vi.spyOn>): Promise<void> {
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).not.toContain(SENTINEL);
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
  }

  it("answers with the fixed 500 when authentication throws", async () => {
    const h = await makeProductionHarness();
    const { key } = await create(h, "Melo");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = storeThatThrows(h, ["transaction"]);
    const deps = { ...h.deps, store: failing, agentAuth: createKeyAgentAuthenticator(failing) };
    await expectFixedFailure(await handleMcpRequest(initializeRequest(bearer(key)), deps), logged);
  });

  it("answers with the fixed 500 when the agent's rate limit throws", async () => {
    const h = await makeProductionHarness();
    const { key } = await create(h, "Melo");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Authentication works (it uses the real store); only the limiter fails.
    const deps = { ...h.deps, store: storeThatThrows(h, ["hitRateLimit"]) };
    await expectFixedFailure(await handleMcpRequest(initializeRequest(bearer(key)), deps), logged);
  });

  it("answers with the fixed 500 when the unauthenticated rate limit throws", async () => {
    const h = await makeProductionHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = { ...h.deps, store: storeThatThrows(h, ["hitRateLimit"]) };
    await expectFixedFailure(await handleMcpRequest(initializeRequest(), deps), logged);
    await expectFixedFailure(await handleMcpRequest(initializeRequest(bearer("z".repeat(47))), deps), logged);
  });

  it("answers with the fixed 500 when the request itself cannot be read", async () => {
    const h = await makeProductionHarness();
    const { key } = await create(h, "Melo");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = initializeRequest(bearer(key));
    Object.defineProperty(request, "headers", {
      get() {
        throw new Error(`headers said ${SENTINEL}`);
      },
    });
    await expectFixedFailure(await handleMcpRequest(request, h.deps), logged);
  });
});
