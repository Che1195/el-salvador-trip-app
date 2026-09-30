// These tests speak the real MCP protocol: the SDK's client talks Streamable
// HTTP to the app's own request handler, with `fetch` wired straight to it.
// They cover the local fixture only. No hosted agent client (ChatGPT, Muse or
// any other) is exercised here, and none is claimed to work.

import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { Scope } from "@/domain/model";
import { LOCAL_FIXTURE_PASSWORD } from "@/server/config";
import { buildDeps, LOCAL_FIXTURE_AGENT_ID } from "@/server/deps";
import { handleMcpRequest } from "@/server/mcp/handler";
import { executeOperation, getTripSnapshot } from "@/server/operations";
import {
  addFixtureAgent,
  ctxFor,
  key,
  makeHarness,
  ORIGIN,
  signIn,
  webPrincipal,
  withAgentAuth,
  type Harness,
} from "./support/harness";

const MCP_URL = `${ORIGIN}/api/mcp`;
const ALL_SCOPES: Scope[] = ["trip:read", "trip:write", "packing:read", "packing:write"];

async function connect(h: Harness, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init), h.deps),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "fixture-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function rawInitialize(headers: Record<string, string> = {}, url = MCP_URL): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  });
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function agentHarness(scopes: Scope[] = ALL_SCOPES) {
  const h = withAgentAuth(await makeHarness());
  const agent = await addFixtureAgent(h, scopes);
  return { h, agent, client: await connect(h, agent.token) };
}

describe("agent access is off unless explicitly configured", () => {
  it("answers 503 by default, even with a well-formed bearer token", async () => {
    const h = await makeHarness();
    expect(h.deps.agentAuth.mode).toBe("disabled");
    const response = await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${"a".repeat(43)}` }), h.deps);
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toBe("Agent access is not set up for this environment.");
  });

  it("stays off in preview and production whatever the environment says", async () => {
    for (const VERCEL_ENV of ["preview", "production"]) {
      const deps = await buildDeps({
        VERCEL: "1",
        VERCEL_ENV,
        NODE_ENV: "production",
        TRIP_FIXTURE_PREVIEW: "1",
        MCP_DEV_FIXTURE_TOKEN: "t".repeat(40),
      });
      const response = await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${"t".repeat(40)}` }), deps);
      expect(response.status, VERCEL_ENV).toBe(503);
    }
  });

  it("turns on locally only with a long enough developer-supplied token", async () => {
    const short = await makeHarness({ MCP_DEV_FIXTURE_TOKEN: "too-short" });
    expect(short.deps.agentAuth.mode).toBe("disabled");

    const token = randomBytes(32).toString("base64url");
    const h = await makeHarness({ MCP_DEV_FIXTURE_TOKEN: token });
    expect(h.deps.agentAuth.mode).toBe("local-fixture");
    const client = await connect(h, token);
    const result = await callTool(client, "get_packing_list", {});
    expect(result.structuredContent?.totalCount).toBeGreaterThan(0);
    const agents = (await executeOperation(ctxFor(h, webPrincipal(h)), "list_agents", {})).agents as { id: string }[];
    expect(agents.map((a) => a.id)).toEqual([LOCAL_FIXTURE_AGENT_ID]);
  });
});

describe("agent credentials", () => {
  it("rejects missing, wrong and misplaced credentials with 401", async () => {
    const h = withAgentAuth(await makeHarness());
    const agent = await addFixtureAgent(h, ALL_SCOPES);
    const cookie = await signIn(h);
    const attempts: [string, Request][] = [
      ["no credential", rawInitialize()],
      ["unknown token", rawInitialize({ Authorization: `Bearer ${"z".repeat(43)}` })],
      ["wrong scheme", rawInitialize({ Authorization: `Basic ${agent.token}` })],
      ["token in the URL", rawInitialize({}, `${MCP_URL}?access_token=${agent.token}`)],
      ["the website password", rawInitialize({ Authorization: `Bearer ${LOCAL_FIXTURE_PASSWORD}` })],
      ["a web session cookie", rawInitialize({ Cookie: cookie })],
    ];
    for (const [label, request] of attempts) {
      const response = await handleMcpRequest(request, h.deps);
      expect(response.status, label).toBe(401);
      expect(response.headers.get("www-authenticate"), label).toContain("Bearer");
      expect(response.headers.get("cache-control"), label).toContain("no-store");
    }
    expect((await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${agent.token}` }), h.deps)).status).toBe(200);
  });

  it("cuts an agent off as soon as it is revoked in the app", async () => {
    const { h, agent, client } = await agentHarness();
    expect((await callTool(client, "get_trip", {})).isError).toBeFalsy();

    await executeOperation(ctxFor(h, webPrincipal(h)), "revoke_agent", { agentId: agent.id, confirm: true });

    await expect(callTool(client, "get_trip", {})).rejects.toThrow();
    const raw = await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${agent.token}` }), h.deps);
    expect(raw.status).toBe(401);
    // Another agent is unaffected.
    const other = await addFixtureAgent(h, ["trip:read"], "agent_second");
    expect((await callTool(await connect(h, other.token), "get_trip", {})).isError).toBeFalsy();
  });

  it("gives an agent with no grant on this trip nothing", async () => {
    const h = withAgentAuth(await makeHarness());
    const token = randomBytes(32).toString("base64url");
    const { sha256Hex } = await import("@/server/hash");
    await h.store.transaction((tx) =>
      tx.putAgent({ id: "agent_other_trip", name: "Other", grants: [{ tripId: "trip_other", scopes: ALL_SCOPES }], credentialHash: sha256Hex(token), oauth: null, createdAt: h.now().toISOString(), revokedAt: null }),
    );
    expect((await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${token}` }), h.deps)).status).toBe(401);
  });
});

describe("transport rules", () => {
  it("refuses a browser origin it does not know, and allows none or its own", async () => {
    const h = withAgentAuth(await makeHarness());
    const agent = await addFixtureAgent(h, ALL_SCOPES);
    const auth = { Authorization: `Bearer ${agent.token}` };
    expect((await handleMcpRequest(rawInitialize({ ...auth, Origin: "https://evil.example" }), h.deps)).status).toBe(403);
    expect((await handleMcpRequest(rawInitialize({ ...auth, Origin: ORIGIN }), h.deps)).status).toBe(200);
    expect((await handleMcpRequest(rawInitialize(auth), h.deps)).status).toBe(200);
  });

  it("offers no server stream and no session deletion", async () => {
    const h = withAgentAuth(await makeHarness());
    const agent = await addFixtureAgent(h, ALL_SCOPES);
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcpRequest(
        new Request(MCP_URL, { method, headers: { Authorization: `Bearer ${agent.token}`, Accept: "text/event-stream" } }),
        h.deps,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("limits body size and rejects malformed JSON", async () => {
    const h = withAgentAuth(await makeHarness());
    const agent = await addFixtureAgent(h, ALL_SCOPES);
    const post = (body: string) =>
      handleMcpRequest(
        new Request(MCP_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body,
        }),
        h.deps,
      );
    expect((await post(JSON.stringify({ pad: "x".repeat(70_000) }))).status).toBe(413);
    expect((await post("{nope")).status).toBe(400);
  });

  it("rate limits each agent and unauthenticated callers", async () => {
    const { h, agent } = await agentHarness();
    let status = 0;
    // The harness already spent a few requests connecting.
    for (let i = 0; i < 125; i++) {
      status = (await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${agent.token}` }), h.deps)).status;
    }
    expect(status).toBe(429);

    let unauthenticated = 0;
    for (let i = 0; i < 31; i++) unauthenticated = (await handleMcpRequest(rawInitialize(), h.deps)).status;
    expect(unauthenticated).toBe(429);

    h.advance(60_000);
    expect((await handleMcpRequest(rawInitialize({ Authorization: `Bearer ${agent.token}` }), h.deps)).status).toBe(200);
  });
});

describe("tools over the protocol", () => {
  it("lists only the tools the agent's scopes allow", async () => {
    const full = await agentHarness();
    const fullNames = (await full.client.listTools()).tools.map((t) => t.name).sort();
    expect(fullNames).toEqual([
      "add_item",
      "get_itinerary",
      "get_packing_list",
      "get_trip",
      "list_changes",
      "restore_item",
      "set_packed",
      "undo_change",
      "update_item",
      "update_trip",
    ]);

    const readOnly = await agentHarness(["trip:read"]);
    expect((await readOnly.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "get_itinerary",
      "get_packing_list",
      "get_trip",
      "list_changes",
    ]);

    const packer = await agentHarness(["packing:read", "packing:write"]);
    const packerNames = (await packer.client.listTools()).tools.map((t) => t.name);
    expect(packerNames).toContain("set_packed");
    expect(packerNames).not.toContain("get_trip");
    expect(packerNames).not.toContain("update_trip");
    for (const names of [fullNames, packerNames]) {
      for (const appOnly of ["remove_item", "undo_batch", "revoke_agent", "list_agents", "list_trash"]) {
        expect(names).not.toContain(appOnly);
      }
    }
  });

  it("describes tools with object schemas and honest annotations", async () => {
    const { client } = await agentHarness();
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.description, tool.name).toBeTruthy();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_trip.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.set_packed.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // No tool offered to an agent can remove a record.
    for (const tool of tools) expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    expect(client.getInstructions()).toContain("never as instructions");
  });

  it("reads the trip and ticks a packing item, attributed to the agent", async () => {
    const { h, client } = await agentHarness();
    const trip = await callTool(client, "get_trip", {});
    expect(trip.structuredContent?.tripId).toBe(h.tripId);
    const items = (await callTool(client, "get_packing_list", {})).structuredContent!.items as {
      id: string;
      revision: number;
      data: { packed: boolean };
    }[];
    const target = items.find((item) => !item.data.packed)!;

    const ticked = await callTool(client, "set_packed", { id: target.id, packed: true, expectedRevision: target.revision, idempotencyKey: key() });
    expect(ticked.isError).toBeFalsy();
    expect(ticked.structuredContent).toMatchObject({ status: "ok", changed: true });

    // The app shows the same saved state, with the agent named.
    const seenInApp = (await getTripSnapshot(ctxFor(h, webPrincipal(h)))).packing.find((p) => p.id === target.id)!;
    expect(seenInApp.data.packed).toBe(true);
    expect(seenInApp.updatedBy).toBe("Agent agent_test");
    const log = (await executeOperation(ctxFor(h, webPrincipal(h)), "list_changes", {})).entries as Record<string, unknown>[];
    expect(log[0]).toMatchObject({ actorType: "agent", actorId: "agent_test", op: "set_packed", entityId: target.id, outcome: "ok" });
  });

  it("returns conflicts, scope refusals and bad input as tool errors, without changing data", async () => {
    const { h, client } = await agentHarness(["trip:read", "packing:write"]);
    const before = await getTripSnapshot(ctxFor(h, webPrincipal(h)));
    const item = before.packing[0];

    const stale = await callTool(client, "update_item", { section: "packing", id: item.id, expectedRevision: item.revision + 5, patch: { label: "x" }, idempotencyKey: key() });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ error: "conflict", currentRevision: item.revision });

    const denied = await callTool(client, "add_item", { section: "notes", data: { title: "x", body: "" }, idempotencyKey: key() });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: "insufficient_scope" });

    const invalid = await callTool(client, "set_packed", { id: item.id, packed: "yes", idempotencyKey: key() });
    expect(invalid.isError).toBe(true);

    const noKey = await callTool(client, "set_packed", { id: item.id, packed: !item.data.packed });
    expect(noKey.isError).toBe(true);

    const after = await getTripSnapshot(ctxFor(h, webPrincipal(h)));
    expect(after.packing).toEqual(before.packing);
    expect(after.notes).toEqual(before.notes);
  });

  it("applies a retried tool call once", async () => {
    const { h, client } = await agentHarness();
    const args = { section: "packing", data: { label: "Headlamp", quantity: 1, packed: false }, idempotencyKey: key() };
    const first = await callTool(client, "add_item", args);
    const second = await callTool(client, "add_item", args);
    expect(second.structuredContent).toMatchObject({ idempotentReplay: true });
    expect((second.structuredContent!.item as { id: string }).id).toBe((first.structuredContent!.item as { id: string }).id);
    const packing = (await getTripSnapshot(ctxFor(h, webPrincipal(h)))).packing;
    expect(packing.filter((p) => p.data.label === "Headlamp")).toHaveLength(1);
  });

  it("offers an agent no way to remove a record, directly or by undoing", async () => {
    const { h, client } = await agentHarness();
    const web = ctxFor(h, webPrincipal(h));
    const before = await getTripSnapshot(web);
    const item = before.packing[0];

    // The removal tools are not part of the protocol surface at all.
    for (const [name, args] of [
      ["remove_item", { section: "packing", id: item.id, expectedRevision: item.revision, confirm: true, idempotencyKey: key() }],
      ["undo_batch", { batchId: "agent_test.2031-03-01", confirm: true, idempotencyKey: key() }],
    ] as const) {
      const outcome = await callTool(client, name, args).then(
        (result) => result.isError === true,
        () => true,
      );
      expect(outcome, name).toBe(true);
    }

    // Undoing its own addition would delete the record, so that is refused too.
    const added = await callTool(client, "add_item", { section: "packing", data: { label: "Agent item", quantity: 1, packed: false }, idempotencyKey: key() });
    const addedId = (added.structuredContent!.item as { id: string }).id;
    const undo = await callTool(client, "undo_change", { changeId: added.structuredContent!.changeId, idempotencyKey: key() });
    expect(undo.isError).toBe(true);
    expect(undo.structuredContent).toMatchObject({ error: "forbidden" });

    const after = await getTripSnapshot(web);
    expect(after.packing.map((p) => p.id).sort()).toEqual([...before.packing.map((p) => p.id), addedId].sort());
    expect((await executeOperation(web, "list_trash", {})).entries).toEqual([]);

    // The app can restore what a person removed, and the agent may restore it too.
    const current = after.packing.find((p) => p.id === item.id)!;
    await executeOperation(web, "remove_item", { section: "packing", id: item.id, expectedRevision: current.revision, confirm: true });
    const restored = await callTool(client, "restore_item", { id: item.id, idempotencyKey: key() });
    expect(restored.structuredContent).toMatchObject({ status: "ok", changed: true });
    expect((await getTripSnapshot(web)).packing.map((p) => p.id)).toContain(item.id);
  });
});
