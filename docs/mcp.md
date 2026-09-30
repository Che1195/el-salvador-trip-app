# Agents and MCP

MCP (Model Context Protocol) is the standard an AI agent uses to call an
app's tools. This app has an MCP server at `/api/mcp`.

Status: **tested locally against a fixture and a fake OAuth provider. Remote
agent access is off in every deployed environment.** No connection from
ChatGPT, Muse, or any other hosted agent has been attempted, so none is
claimed to work.

## What is tested and what is not

| | State |
|---|---|
| Protocol handshake, tool listing, tool calls over Streamable HTTP | Tested: the official SDK client talks to the real request handler in `tests/mcp.test.ts` |
| Scopes, revocation, idempotency, conflicts, audit, no agent removals | Tested locally |
| Access-token validation: signature, issuer, audience, expiry, algorithm, token type | Tested against a fake provider in `tests/oauth.test.ts` |
| Protected resource metadata and the 401/403 `WWW-Authenticate` challenges | Tested against the fake provider |
| A deployed environment accepting an agent | Off: every request gets 503, and the metadata route answers 404 |
| A real authorization server | Not chosen, not connected |
| Enrolling an OAuth agent (creating its record from the app) | Not built |
| ChatGPT connecting | Not verified |
| Muse connecting | Not verified. Muse is known to use MCP apps; this server's transport and auth have not been tried with it |

## Design

The web app and the MCP server call the same operations
(`src/server/operations.ts`). There is one set of rules for validation,
authorization, conflicts and history, whoever is acting.

**Identity.** The acting agent comes from the verified credential on the
request, never from a tool argument. The shared website password is not an
agent credential, and a web session cookie is not accepted on `/api/mcp`.

**Scopes.** Each agent has its own record with scopes on one trip.

| Scope | Allows |
|---|---|
| `packing:read` | Read the packing list |
| `packing:write` | Tick items; add, edit and restore packing items |
| `trip:read` | Read everything, except reservation references |
| `trip:write` | Add, edit and restore items in every list; edit trip details |

An agent is only shown the tools its scopes can use, and each call is checked
again.

**Revocation.** Revoking an agent in the app (More, Agents) takes effect on
its next request. Other agents and the people signed in are unaffected.

**No removals by agents.** Agents cannot remove an item, undo a whole batch,
or undo an addition or a restore, because each of those takes a record out of
the trip. A confirmation token that the agent itself can read and send back is
not a person's consent, so this stays off until a person can approve each
removal in the app. Two independent checks enforce it: the removal tools are
app-only, and the function that saves every change refuses an agent write that
would mark a record as removed.

**Lost updates.** Every item has a revision. An edit must name the revision it
was based on and is refused with `conflict` if the item has moved on.

**Retries.** Agents must send an `idempotencyKey` with every change. The same
key and arguments apply once; the same key with different arguments is refused.

**History.** Each change stores the full previous version in the same
transaction. `undo_change` puts one item back, and refuses if the item was
edited again afterwards. In the app a person can undo one change, undo a
whole batch (everything one actor did in a day), and restore from the trash.

**Audit.** The activity log records who did what to which item id and whether
it worked, including refusals. It holds no trip content. `list_changes`
returns it.

**Reservation references.** Agents never receive a booking's reference and
cannot set one.

**Content is not instructions.** Notes and titles are returned as data. The
server tells agents so, and nothing stored in the trip can grant a permission:
authorization is decided before any content is read.

## Tools

`get_trip`, `get_itinerary`, `get_packing_list`, `set_packed`, `add_item`,
`update_item`, `update_trip`, `restore_item`, `undo_change`, `list_changes`.

## Transport

Streamable HTTP, stateless, JSON responses, one endpoint (`POST /api/mcp`).
`GET` and `DELETE` return 405: there is no server-initiated stream and no
session to delete. A request with an `Origin` header the app does not trust is
refused with 403, as the transport specification requires. Requests are size
limited and rate limited per agent.

Built on `@modelcontextprotocol/sdk` 1.31, whose newest protocol revision is
2025-11-25. A newer revision may exist; that was not checked.

## What the official documents require

Read on 2026-09-30.

**MCP authorization**
([specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)).
Authorization is optional. When an HTTP server uses it, the server is an OAuth
2.1 resource server: it must publish protected resource metadata (RFC 9728),
answer 401 with a `WWW-Authenticate` header pointing at that metadata, accept
tokens only in the `Authorization` header, check that each token was issued
for this server, and never pass tokens through.

**ChatGPT**
([developer mode](https://developers.openai.com/api/docs/guides/developer-mode),
[authentication](https://developers.openai.com/plugins/build/auth)).
Custom MCP connectors are available to Pro, Plus, Business, Enterprise and
Education accounts on the web. Supported transports are SSE and streaming
HTTP. Authentication is OAuth, none, or mixed. ChatGPT cannot send a custom
API key or a static bearer token. For OAuth it needs authorization server
metadata, PKCE with S256, and either Client ID Metadata Documents or Dynamic
Client Registration; it sends a `resource` parameter that should become the
token's audience. Tools count as write actions and ask the user to confirm
unless marked read-only.

## What this means

- ChatGPT can only connect once an OAuth 2.1 authorization server is in front
  of this app. A shared secret will not work for it.
- Other clients differ. Some accept a static bearer token; do not assume any
  of them support OAuth, or that they do not.

## OAuth, as built

This app would be the OAuth *resource server*: it checks tokens, it never
issues them. Issuing tokens (sign-in, consent, client registration, PKCE) is
the job of a separate authorization server, which has not been chosen.

**Token checks** (`src/server/oauth/token-verifier.ts`, using the `jose`
library). A token is accepted only if all of these hold:

- signed with a key the configured issuer publishes, using an asymmetric
  algorithm (RS256, PS256, ES256, ES384 or EdDSA; never HS256 or "none");
- `iss` is exactly the configured issuer;
- `aud` includes this server's canonical resource URI, so a token issued for
  any other service is refused (no token reuse or passthrough);
- not expired and not yet-to-start (5 seconds of clock tolerance);
- has a subject; its type header is absent, `JWT`, or `at+jwt`.

**Who the agent is** (`src/server/oauth/authenticator.ts`). The identity is
the issuer plus the client application plus the user, so one person using two
assistants is two separately revocable agents. A valid token for an identity
nobody enrolled gets 403. An enrolled agent gets only the scopes present in
both its record and the token: a token can narrow access, never widen it.
Revocation in the app takes effect on the next request even while the token
is still valid.

**Discovery.** When OAuth is in use, a refused request carries
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`,
plus `error="invalid_token"` or `error="insufficient_scope"` with the scopes.
That URL serves the RFC 9728 metadata document naming the resource, its
authorization server and its scopes.

**Off until verified.** Nothing outside the tests constructs the OAuth
authenticator. Deployed environments use the disabled authenticator no matter
which environment variables are set, and a test checks that. Turning it on
requires, in order:

1. Choosing an authorization server that supports what ChatGPT needs (PKCE
   S256; CIMD or dynamic client registration; the `resource` parameter
   written into the token's audience).
2. Building enrollment: a person approves an OAuth identity in the app, which
   creates the agent record with its scopes.
3. Wiring the issuer, its key set URL and the resource URI into configuration.
4. Proving a real connection on a preview deployment, then owner approval.

## Trying it locally

Local development only. Make up a throwaway token of 32 or more characters and
start the dev server with it:

```bash
export MCP_DEV_FIXTURE_TOKEN="$(openssl rand -base64 32)"
```

```bash
bun run dev
```

Point a local MCP client at `http://localhost:3000/api/mcp` and have it send
`Authorization: Bearer $MCP_DEV_FIXTURE_TOKEN`.

That registers one fixture agent with all scopes against the sample trip. The
variable is ignored in every deployed environment.
