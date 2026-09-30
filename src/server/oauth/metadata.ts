// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
//
// An MCP client that gets a 401 reads this document to learn which
// authorization server issues tokens for this server. It is public and holds
// no secret and no trip data. While agent access is off, there is nothing to
// advertise and the route answers 404.

import "server-only";
import type { ProtectedResourceInfo } from "../agent-auth";
import type { Deps } from "../deps";
import { jsonResponse } from "../http";

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** Where a client finds the metadata for a resource, per RFC 9728 section 3.1. */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${WELL_KNOWN}${path}`;
}

export function protectedResourceMetadata(info: ProtectedResourceInfo) {
  return {
    resource: info.resource,
    authorization_servers: [...info.authorizationServers],
    scopes_supported: [...info.scopesSupported],
    bearer_methods_supported: ["header"],
    resource_name: "Trip planner",
  };
}

export async function handleProtectedResourceMetadata(request: Request, deps: Deps): Promise<Response> {
  const info = deps.agentAuth.protectedResource;
  const notFound = () => jsonResponse(404, { error: "not_found", message: "Not found." });
  if (!info) return notFound();

  // Serve it at the bare well-known path and at the path-qualified one for
  // this resource. Any other path names a resource this server does not have.
  const requested = new URL(request.url).pathname;
  const expected = new URL(resourceMetadataUrl(info.resource)).pathname;
  if (requested !== WELL_KNOWN && requested !== expected) return notFound();

  return jsonResponse(200, protectedResourceMetadata(info), {
    // Public by design: browser-based clients fetch it cross-origin.
    "Access-Control-Allow-Origin": "*",
  });
}
