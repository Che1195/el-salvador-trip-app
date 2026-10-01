// OAuth access-token validation and the MCP authorization metadata, tested
// against a fake authorization server (tests/support/fake-oauth.ts).
//
// What this proves: the resource-server side behaves as the MCP authorization
// specification requires, for tokens shaped like the fake provider's.
// What it does not prove: that any real provider, or ChatGPT, Muse or another
// hosted client, works with it. Deployed environments never construct it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "@/domain/model";
import { LOCAL_FIXTURE_PASSWORD } from "@/server/config";
import { buildDeps, type Deps } from "@/server/deps";
import { handleMcpRequest } from "@/server/mcp/handler";
import { createOAuthAgentAuthenticator } from "@/server/oauth/authenticator";
import { handleProtectedResourceMetadata, resourceMetadataUrl } from "@/server/oauth/metadata";
import { createJwtAccessTokenVerifier } from "@/server/oauth/token-verifier";
import { executeOperation } from "@/server/operations";
import { createFakeProvider, FAKE_ISSUER, FAKE_RESOURCE, handmadeToken, type FakeProvider } from "./support/fake-oauth";
import { ctxFor, key, makeHarness, makeProductionHarness, makeRequest, signIn, webPrincipal, type Harness } from "./support/harness";

const ALL: Scope[] = ["trip:read", "trip:write", "packing:read", "packing:write"];
const METADATA_URL = "http://localhost:3000/.well-known/oauth-protected-resource/api/mcp";

afterEach(() => {
  vi.restoreAllMocks();
});

async function oauthHarness(grantScopes: Scope[] = ALL): Promise<{ h: Harness; provider: FakeProvider }> {
  const base = await makeHarness();
  const provider = await createFakeProvider(base.now);
  const verifier = createJwtAccessTokenVerifier({ issuer: FAKE_ISSUER, audience: FAKE_RESOURCE, keys: provider.keys, clock: base.now });
  const agentAuth = createOAuthAgentAuthenticator({ store: base.store, verifier, resource: FAKE_RESOURCE, issuer: FAKE_ISSUER });
  await base.store.transaction((tx) =>
    tx.putAgent({
      id: "agent_oauth",
      name: "OAuth assistant",
      grants: [{ tripId: base.tripId, scopes: grantScopes }],
      credentialHash: null,
      oauth: { issuer: FAKE_ISSUER, subject: "client-1|user-1" },
      createdAt: base.now().toISOString(),
      revokedAt: null,
    }),
  );
  return { h: { ...base, deps: { ...base.deps, agentAuth } }, provider };
}

function initialize(headers: Record<string, string> = {}, url = FAKE_RESOURCE): Request {
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

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function connect(h: Harness, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(FAKE_RESOURCE), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init), h.deps),
    requestInit: { headers: bearer(token) },
  });
  const client = new Client({ name: "oauth-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("access token validation", () => {
  async function verifierFor(h: Harness, provider: FakeProvider) {
    return createJwtAccessTokenVerifier({ issuer: FAKE_ISSUER, audience: FAKE_RESOURCE, keys: provider.keys, clock: h.now });
  }

  it("accepts a well-formed token and returns its claims", async () => {
    const { h, provider } = await oauthHarness();
    const verifier = await verifierFor(h, provider);
    const seconds = Math.floor(h.now().getTime() / 1000);
    expect(await verifier.verify(await provider.issue())).toEqual({
      issuer: FAKE_ISSUER,
      subject: "user-1",
      clientId: "client-1",
      scopes: ["trip:read", "trip:write", "packing:read", "packing:write"],
      expiresAt: seconds + 300,
    });
    // Variations real providers use.
    expect((await verifier.verify(await provider.issue({ aud: ["https://other.example", FAKE_RESOURCE] })))?.subject).toBe("user-1");
    expect((await verifier.verify(await provider.issue({ scope: undefined, scp: ["packing:read"] })))?.scopes).toEqual(["packing:read"]);
    expect((await verifier.verify(await provider.issue({ client_id: undefined, azp: "client-9" })))?.clientId).toBe("client-9");
    expect((await verifier.verify(await provider.issue({}, { header: { typ: "JWT" } })))?.subject).toBe("user-1");
  });

  it("rejects a token meant for a different server, which is what stops token reuse", async () => {
    const { h, provider } = await oauthHarness();
    const verifier = await verifierFor(h, provider);
    for (const aud of ["https://another-mcp-server.example/mcp", "http://localhost:3000", "http://localhost:3000/api/mcp/", "client-1", undefined]) {
      expect(await verifier.verify(await provider.issue({ aud })), String(aud)).toBeNull();
    }
  });

  it("rejects the wrong issuer, an expired token, a not-yet-valid token, and missing claims", async () => {
    const { h, provider } = await oauthHarness();
    const verifier = await verifierFor(h, provider);
    const seconds = Math.floor(h.now().getTime() / 1000);
    expect(await verifier.verify(await provider.issue({ iss: "https://evil.example" }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ iss: `${FAKE_ISSUER}/` }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ exp: seconds - 60 }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ nbf: seconds + 600 }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ exp: undefined }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ sub: undefined }))).toBeNull();
    expect(await verifier.verify(await provider.issue({ sub: "" }))).toBeNull();

    const token = await provider.issue();
    expect(await verifier.verify(token)).not.toBeNull();
    h.advance(306_000);
    expect(await verifier.verify(token)).toBeNull();
  });

  it("rejects forged signatures and unsafe algorithms", async () => {
    const { h, provider } = await oauthHarness();
    const verifier = await verifierFor(h, provider);
    const seconds = Math.floor(h.now().getTime() / 1000);
    const claims = { iss: FAKE_ISSUER, aud: FAKE_RESOURCE, sub: "user-1", client_id: "client-1", scope: "trip:write", iat: seconds, exp: seconds + 300 };

    // Signed with a key the provider never published, under the published key's id.
    expect(await verifier.verify(await provider.issue({}, { key: provider.strangerKey }))).toBeNull();
    // A key id the provider does not have.
    expect(await verifier.verify(await provider.issue({}, { header: { kid: "unknown" } }))).toBeNull();
    // A genuine token with its payload swapped.
    const [header, , signature] = (await provider.issue()).split(".");
    const swapped = Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })).toString("base64url");
    expect(await verifier.verify(`${header}.${swapped}.${signature}`)).toBeNull();
    // No signature at all.
    expect(await verifier.verify(handmadeToken({ alg: "none", typ: "at+jwt" }, claims))).toBeNull();
    expect(await verifier.verify(handmadeToken({ alg: "ES256", kid: "fake-key-1" }, claims))).toBeNull();
    // Algorithm confusion: a symmetric signature made from the public key.
    const confused = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: "fake-key-1", typ: "at+jwt" })
      .sign(new TextEncoder().encode(JSON.stringify(provider.publicJwk)));
    expect(await verifier.verify(confused)).toBeNull();
  });

  it("rejects other kinds of token and malformed input without throwing", async () => {
    const { h, provider } = await oauthHarness();
    const verifier = await verifierFor(h, provider);
    expect(await verifier.verify(await provider.issue({}, { header: { typ: "dpop+jwt" } }))).toBeNull();
    expect(await verifier.verify(await provider.issue({}, { header: { typ: "logout+jwt" } }))).toBeNull();
    for (const junk of ["", "abc", "a.b.c", "....", "x".repeat(9000), LOCAL_FIXTURE_PASSWORD]) {
      expect(await verifier.verify(junk)).toBeNull();
    }
  });
});

describe("agents over OAuth", () => {
  it("serves MCP to an enrolled agent with a valid token, attributed to that agent", async () => {
    const { h, provider } = await oauthHarness();
    const client = await connect(h, await provider.issue());
    const list = (await client.callTool({ name: "get_packing_list", arguments: {} })) as unknown as {
      structuredContent: { items: { id: string; data: { packed: boolean } }[] };
    };
    const target = list.structuredContent.items.find((item) => !item.data.packed)!;
    const ticked = (await client.callTool({ name: "set_packed", arguments: { id: target.id, packed: true, idempotencyKey: key() } })) as { isError?: boolean };
    expect(ticked.isError).toBeFalsy();
    const log = (await executeOperation(ctxFor(h, webPrincipal(h)), "list_changes", { limit: 1 })).entries as Record<string, unknown>[];
    expect(log[0]).toMatchObject({ actorType: "agent", actorId: "agent_oauth", actorLabel: "OAuth assistant", op: "set_packed", outcome: "ok" });
  });

  it("gives only the scopes present in both the token and the agent's record", async () => {
    const tools = async (h: Harness, token: string) => (await (await connect(h, token)).listTools()).tools.map((t) => t.name).sort();

    // The token narrows a wide grant.
    const wide = await oauthHarness(ALL);
    expect(await tools(wide.h, await wide.provider.issue({ scope: "packing:read" }))).toEqual(["get_packing_list", "list_changes"]);

    // The token cannot widen a narrow grant, whatever scopes it claims.
    const narrow = await oauthHarness(["packing:read", "packing:write"]);
    const names = await tools(narrow.h, await narrow.provider.issue({ scope: "trip:read trip:write packing:read packing:write admin" }));
    expect(names).toContain("set_packed");
    expect(names).not.toContain("get_trip");
    expect(names).not.toContain("update_trip");
    // Removal tools are never offered, OAuth or not.
    expect(names).not.toContain("remove_item");
    expect(names).not.toContain("undo_batch");
  });

  it("answers 401 with a pointer to the metadata when there is no usable token", async () => {
    const { h, provider } = await oauthHarness();
    const cookie = await signIn(h);

    const none = await handleMcpRequest(initialize(), h.deps);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA_URL}"`);

    const attempts: [string, Request][] = [
      ["expired", initialize(bearer(await provider.issue({ exp: Math.floor(h.now().getTime() / 1000) - 60 })))],
      ["other audience", initialize(bearer(await provider.issue({ aud: "https://another-mcp-server.example/mcp" })))],
      ["forged", initialize(bearer(await provider.issue({}, { key: provider.strangerKey })))],
      ["website password", initialize(bearer(LOCAL_FIXTURE_PASSWORD))],
      ["wrong scheme", initialize({ Authorization: `Basic ${await provider.issue()}` })],
    ];
    for (const [label, request] of attempts) {
      const response = await handleMcpRequest(request, h.deps);
      expect(response.status, label).toBe(401);
      expect(response.headers.get("www-authenticate"), label).toBe(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
    }

    // A token in the URL, or a web session cookie, is not a credential here.
    const inUrl = await handleMcpRequest(initialize({}, `${FAKE_RESOURCE}?access_token=${await provider.issue()}`), h.deps);
    expect(inUrl.status).toBe(401);
    expect((await handleMcpRequest(initialize({ Cookie: cookie }), h.deps)).status).toBe(401);
  });

  it("answers 403 to a genuine token that grants nothing here", async () => {
    const { h, provider } = await oauthHarness();
    const expectForbidden = async (label: string, token: string) => {
      const response = await handleMcpRequest(initialize(bearer(token)), h.deps);
      expect(response.status, label).toBe(403);
      const header = response.headers.get("www-authenticate") ?? "";
      expect(header, label).toContain('error="insufficient_scope"');
      expect(header, label).toContain(`resource_metadata="${METADATA_URL}"`);
      expect(header, label).toContain('scope="trip:read packing:read packing:write trip:write"');
    };
    // Valid tokens for callers nobody enrolled: another client app, another user.
    await expectForbidden("unknown client", await provider.issue({ client_id: "client-2" }));
    await expectForbidden("unknown user", await provider.issue({ sub: "user-2" }));
    await expectForbidden("no client id", await provider.issue({ client_id: undefined }));
    // Enrolled, but the token carries none of this app's scopes.
    await expectForbidden("unrelated scopes", await provider.issue({ scope: "openid profile email" }));
    await expectForbidden("no scopes", await provider.issue({ scope: undefined }));
    // The enrolled agent still works.
    expect((await handleMcpRequest(initialize(bearer(await provider.issue())), h.deps)).status).toBe(200);
  });

  it("cuts off a revoked agent even while its token is still valid", async () => {
    const { h, provider } = await oauthHarness();
    const token = await provider.issue();
    const client = await connect(h, token);
    await executeOperation(ctxFor(h, webPrincipal(h)), "revoke_agent", { agentId: "agent_oauth", confirm: true });
    await expect(client.callTool({ name: "get_packing_list", arguments: {} })).rejects.toThrow();
    expect((await handleMcpRequest(initialize(bearer(token)), h.deps)).status).toBe(403);
    expect((await handleMcpRequest(initialize(bearer(await provider.issue())), h.deps)).status).toBe(403);
  });

  it("gives an agent enrolled on another trip nothing", async () => {
    const { h, provider } = await oauthHarness();
    await h.store.transaction((tx) =>
      tx.putAgent({ id: "agent_elsewhere", name: "Elsewhere", grants: [{ tripId: "trip_other", scopes: ALL }], credentialHash: null, oauth: { issuer: FAKE_ISSUER, subject: "client-3|user-3" }, createdAt: h.now().toISOString(), revokedAt: null }),
    );
    const response = await handleMcpRequest(initialize(bearer(await provider.issue({ client_id: "client-3", sub: "user-3" }))), h.deps);
    expect(response.status).toBe(403);
  });

  it("writes no token to the log", async () => {
    const { h, provider } = await oauthHarness();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const good = await provider.issue();
    const bad = await provider.issue({ aud: "https://another-mcp-server.example/mcp" });
    await handleMcpRequest(initialize(bearer(good)), h.deps);
    await handleMcpRequest(initialize(bearer(bad)), h.deps);
    const output = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(output).not.toContain(good.split(".")[2]);
    expect(output).not.toContain(bad.split(".")[2]);
  });
});

describe("protected resource metadata", () => {
  const get = (path: string, h: Harness) => handleProtectedResourceMetadata(makeRequest(path), h.deps);

  it("describes this server and its authorization server once OAuth is in use", async () => {
    const { h } = await oauthHarness();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      const response = await get(path, h);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({
        resource: FAKE_RESOURCE,
        authorization_servers: [FAKE_ISSUER],
        scopes_supported: ["trip:read", "packing:read", "packing:write", "trip:write"],
        bearer_methods_supported: ["header"],
        resource_name: "Trip planner",
      });
    }
    expect((await get("/.well-known/oauth-protected-resource/api/other", h)).status).toBe(404);
    expect((await get("/.well-known/oauth-protected-resource/api/mcp/extra", h)).status).toBe(404);
  });

  it("builds the metadata address the way RFC 9728 says", () => {
    expect(resourceMetadataUrl("https://trip.example.com/api/mcp")).toBe("https://trip.example.com/.well-known/oauth-protected-resource/api/mcp");
    expect(resourceMetadataUrl("https://trip.example.com")).toBe("https://trip.example.com/.well-known/oauth-protected-resource");
    expect(resourceMetadataUrl("https://trip.example.com/")).toBe("https://trip.example.com/.well-known/oauth-protected-resource");
  });

  it("is absent while agent access is off or uses keys", async () => {
    const off = await makeHarness({ AGENT_ACCESS: "off" });
    expect(off.deps.agentAuth.mode).toBe("disabled");
    expect((await get("/.well-known/oauth-protected-resource", off)).status).toBe(404);
    expect((await get("/.well-known/oauth-protected-resource/api/mcp", off)).status).toBe(404);
    const keys = await makeHarness({ MCP_DEV_FIXTURE_TOKEN: "t".repeat(40) });
    expect(keys.deps.agentAuth.mode).toBe("keys");
    expect((await get("/.well-known/oauth-protected-resource", keys)).status).toBe(404);
    expect((await get("/.well-known/oauth-protected-resource/api/mcp", keys)).status).toBe(404);
  });
});

describe("deployed environments never construct the OAuth authenticator", () => {
  it("ignores every OAuth-looking setting: key mode, no metadata, no OAuth challenge", async () => {
    const oauthLooking = {
      MCP_OAUTH_ISSUER: FAKE_ISSUER,
      MCP_OAUTH_JWKS_URI: `${FAKE_ISSUER}/.well-known/jwks.json`,
      MCP_OAUTH_RESOURCE: FAKE_RESOURCE,
      MCP_RESOURCE: FAKE_RESOURCE,
      OAUTH_ISSUER: FAKE_ISSUER,
      AGENT_ACCESS: "enabled",
      MCP_DEV_FIXTURE_TOKEN: "t".repeat(40),
    };
    const deployments: [string, Deps][] = [
      [
        "preview",
        await buildDeps({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", TRIP_FIXTURE_PREVIEW: "1", ...oauthLooking }),
      ],
      ["production", (await makeProductionHarness(oauthLooking)).deps],
    ];
    for (const [label, deps] of deployments) {
      expect(deps.agentAuth.mode, label).toBe("keys");
      expect(deps.agentAuth.protectedResource, label).toBeUndefined();
      const refused = await handleMcpRequest(initialize(bearer("a".repeat(40))), deps);
      expect(refused.status, label).toBe(401);
      expect(refused.headers.get("www-authenticate"), label).toBe('Bearer realm="trip-planner"');
      const metadata = await handleProtectedResourceMetadata(makeRequest("/.well-known/oauth-protected-resource"), deps);
      expect(metadata.status, label).toBe(404);
    }
  });

  it("answers 503 and publishes no metadata when agent access is switched off", async () => {
    for (const VERCEL_ENV of ["preview", "production"]) {
      const deps = await buildDeps({ VERCEL: "1", VERCEL_ENV, NODE_ENV: "production", AGENT_ACCESS: "off", MCP_OAUTH_ISSUER: FAKE_ISSUER });
      expect(deps.agentAuth.mode, VERCEL_ENV).toBe("disabled");
      expect((await handleMcpRequest(initialize(bearer("a".repeat(40))), deps)).status, VERCEL_ENV).toBe(503);
      const metadata = await handleProtectedResourceMetadata(makeRequest("/.well-known/oauth-protected-resource"), deps);
      expect(metadata.status, VERCEL_ENV).toBe(404);
    }
  });
});
