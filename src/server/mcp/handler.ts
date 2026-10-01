// HTTP entry point for MCP (Streamable HTTP transport, stateless, JSON
// responses). Order of checks: origin, method, agent credential, rate limit,
// body size. Only then is a protocol server built for this one request.

import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Deps } from "../deps";
import { DomainError } from "../errors";
import { clientKey, isJsonContentType, isTrustedOrigin, PRIVATE_HEADERS, readBodyText } from "../http";
import { resourceMetadataUrl } from "../oauth/metadata";
import { buildMcpServer } from "./server";

const MAX_BODY_BYTES = 64 * 1024;
const AGENT_LIMIT_PER_MINUTE = 120;
const UNAUTHENTICATED_LIMIT_PER_MINUTE = 30;

function rpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "application/json", ...headers },
  });
}

/**
 * The WWW-Authenticate value for a refused request. With OAuth it points the
 * client at this server's protected resource metadata (RFC 9728), which is
 * how an MCP client discovers where to get a token.
 */
function challenge(request: Request, deps: Deps, reason: "invalid" | "insufficient"): string {
  const info = deps.agentAuth.protectedResource;
  if (!info) return 'Bearer realm="trip-planner"';
  const parts = [`resource_metadata="${resourceMetadataUrl(info.resource)}"`];
  if (reason === "insufficient") {
    parts.push('error="insufficient_scope"', `scope="${info.scopesSupported.join(" ")}"`);
  } else if (request.headers.has("authorization")) {
    // Only name an error when a credential was actually presented (RFC 6750).
    parts.push('error="invalid_token"');
  }
  return `Bearer ${parts.join(", ")}`;
}

async function handle(request: Request, deps: Deps): Promise<Response> {
  // Browsers always send Origin on cross-site requests. Agents running
  // server-side send none. A present but unknown origin is refused outright.
  const origin = request.headers.get("origin");
  if (origin !== null && !isTrustedOrigin(origin, request, deps.config)) {
    return rpcError(403, -32000, "Origin not allowed.");
  }

  if (request.method !== "POST") {
    // No server-initiated stream and no sessions to delete.
    return rpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
  }

  const store = deps.store;
  const now = deps.clock();
  const auth = await deps.agentAuth.authenticate(request, deps.config.tripId);
  if (!auth.ok) {
    if (auth.reason === "not_configured" || !store) {
      return rpcError(503, -32001, "Agent access is not set up for this environment.");
    }
    const hit = await store.hitRateLimit(`mcp:address:${clientKey(request)}`, UNAUTHENTICATED_LIMIT_PER_MINUTE, 60_000, now);
    if (!hit.allowed) {
      return rpcError(429, -32002, "Too many requests.", { "Retry-After": String(hit.retryAfterSeconds) });
    }
    return rpcError(
      auth.reason === "insufficient" ? 403 : 401,
      -32001,
      auth.reason === "insufficient" ? "This credential has no access here." : "A valid agent credential is required.",
      { "WWW-Authenticate": challenge(request, deps, auth.reason) },
    );
  }
  if (!store) return rpcError(503, -32001, "Storage is not set up for this environment.");

  const hit = await store.hitRateLimit(`mcp:agent:${auth.principal.id}`, AGENT_LIMIT_PER_MINUTE, 60_000, now);
  if (!hit.allowed) {
    return rpcError(429, -32002, "Too many requests.", { "Retry-After": String(hit.retryAfterSeconds) });
  }

  if (!isJsonContentType(request)) {
    return rpcError(415, -32000, "Content-Type must be application/json.");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBodyText(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof DomainError && error.code === "payload_too_large") {
      return rpcError(413, -32000, "Request body too large.");
    }
    return rpcError(400, -32700, "Parse error.");
  }

  const server = buildMcpServer(auth.principal, { store, tripId: deps.config.tripId, clock: deps.clock });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return rpcError(500, -32603, "Internal error.");
  } finally {
    void server.close().catch(() => undefined);
  }
}

/**
 * Everything that can fail, including authentication and rate limiting, runs
 * inside this one boundary. A store or driver error can quote private
 * details, so it is never logged or returned: the caller gets the same fixed
 * answer whatever went wrong.
 */
export async function handleMcpRequest(request: Request, deps: Deps): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch {
    console.error("[trip-app] mcp request failed");
    return rpcError(500, -32603, "Internal error.");
  }
}
