# Per-agent keys: spec and plan

Status: revised after gpt-6.1-sol review (REVISE, 5 findings, all accepted), 2026-10-01. Builds on `main` at `36cec21`.

## Goal

Let many agents use the live MCP server at the same time: Melo, Jeff, the
owner's Grok bots, Claude Code and Codex, and more later. Each gets its own
key, created by a signed-in person in the app, with its own permissions,
revocable on its own, and named in the activity log.

Out of scope: Nova (ChatGPT), which per OpenAI's documentation cannot send a
custom key and needs OAuth, a separate project. Also out: an approval queue
for agent changes (they keep applying immediately, attributed and
undoable), key expiry, and agent removals (still impossible for agents).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Key format | `tpk_` + 32 random bytes, base64url (47 characters) | 256 bits of entropy; the prefix lets secret scanners and people recognize it |
| Storage | Only SHA-256 of the key, in the existing `agents.credential_hash` column | A high-entropy random key needs no salt or slow hash; nothing reversible is stored |
| Shown | Once, in the response to `create_agent` | It cannot be recovered later; rotation is create a new agent, revoke the old |
| Who creates | Any signed-in person, with confirmation. A web-only operation, so agents can never create agents | Matches the shared-password model |
| Permissions | Chosen at creation from presets: Full (`trip:read`, `trip:write`, `packing:read`, `packing:write`), Packing (`packing:read`, `packing:write`), Read only (`trip:read`) | Least privilege without a custom matrix |
| Name | 1 to 40 characters, single line, unique (case-insensitive) among the trip's active agents | It is the attribution label in Activity |
| Limit | At most 25 active agents per trip | Bounds abuse and storage |
| Idempotency | None for `create_agent`; an `idempotencyKey` field is rejected | A replayed result would have to store the key. Server-side name uniqueness stops duplicates; the UI also blocks double submission |
| Lost response | If creation's response never arrives, the agent may exist without anyone having its key. The screen says so, refreshes the list, and points to Revoke, then create again. Names are unique among active agents only, so a revoked name can be reused | No automatic retry, which could create a second agent |
| Audit | `create_agent` and `revoke_agent` lines hold the agent id and outcome only | The audit log never holds content or secrets |
| Turning it on | In every environment with a configured store, the key authenticator is active. With no key created, no MCP request is accepted (401 for a missing or unknown key; 403, 405 and 429 still apply for bad origins, methods and floods) | No extra deploy step; still closed by default |
| Stopping one agent | Revoke in the app. Takes effect on that agent's next request; a request already past authentication may finish | Revocation is stored in the database, so every server instance sees it at once |
| Stopping all agents | Set `AGENT_ACCESS=off` for the environment and redeploy (about a minute). Environment variables only reach new deployments, so this is not instant | Simple and documented; per-agent revocation covers the urgent case |
| Schema | No change. Uses `agents` and `agent_grants` as they are | No migration, so no deploy-order risk |
| Local fixture | `MCP_DEV_FIXTURE_TOKEN` stays local-only and now just seeds one agent record for the same authenticator | One code path |
| OAuth | Still never constructed outside tests | Unchanged |

## Authentication rules for a key

A request is accepted only if: the `Authorization` header is exactly
`Bearer <key>`; SHA-256 of the key matches an agent record; that record is
not revoked; it has a grant for this trip with at least one scope. Unknown
or revoked keys get 401; a genuine key without a grant for this trip gets
403. Keys in the URL, in a cookie, or the website password are never
accepted. The rest of the request pipeline is unchanged: origin check, rate
limits (30 per minute per address unauthenticated, 120 per minute per
agent), body limit, scopes per tool, no removals.

## Revisions after review

gpt-6.1-sol (high, read-only) returned REVISE. Each finding was checked
against the code and accepted:

1. High: the kill switch was described as immediate, but dependencies are
   cached per process and environment variables only reach new deployments.
   Now documented as taking effect on redeploy; per-agent revocation is the
   instant control.
2. Medium: in `src/server/mcp/handler.ts`, authentication and rate limiting
   ran outside the error catch, so a store failure there would escape the
   fixed, `no-store` error response. The whole handler is now inside one
   sanitized error boundary, with a fault-injection test.
3. Medium: new tests would have run on the memory store only. The new suite
   joins the "postgres" test project, and the negative cases below are added.
   PGlite runs transactions one at a time, so genuine concurrent enforcement
   on a real Postgres stays unverified and is recorded as such.
4. Medium: a lost creation response could leave a keyless agent. Recovery is
   now specified (see Decisions).
5. Low: the key is generated inside each transaction attempt and checked
   for an existing hash before insertion; the memory store now enforces the
   same credential-hash uniqueness as the Postgres schema.

## Threats and answers

| Threat | Answer |
|---|---|
| A key leaks | Scoped, revocable in one click, rate limited, cannot remove anything, every change attributed and undoable; kill switch |
| Guessing keys | 256-bit keys, unauthenticated rate limit, lookup by hash |
| Key shows up in logs, URLs or later responses | Only accepted in the header; never logged; never returned after creation; `list_agents` returns no key and no hash |
| Key kept in the browser | Shown in one dialog only; never written to browser storage; dialog content cleared when closed |
| A key used on another trip | Grants are per trip |
| Anyone with the trip password can create keys | Accepted: the shared password already grants everything in the app |
| Response caching | All API responses are `no-store` (existing) |

## Tasks

### Task 1: server (sonnet-5.5, high)

Files: `src/server/agent-auth.ts`, `src/server/config.ts`,
`src/server/deps.ts`, `src/server/operations.ts`, `src/server/hash.ts` (if
a key helper belongs there), `src/server/handlers.ts` (health value),
new `tests/agent-keys.test.ts`, and updates to existing tests that assert
deployed agent access is always off (`tests/config.test.ts`,
`tests/mcp.test.ts`, `tests/oauth.test.ts`, `tests/routes.test.ts`).

1. Replace `createFixtureAgentAuthenticator` with
   `createKeyAgentAuthenticator(store)`, allowed in every environment,
   implementing the rules above, `mode: "keys"`, with no `protectedResource`
   (so OAuth metadata stays absent).
1a. Wrap the whole of `handleMcpRequest` (authentication, rate limits, body
   reading, protocol handling) in one error boundary that returns the fixed
   JSON-RPC 500 with the private headers and logs only a fixed line.
1b. Memory store `putAgent` throws when another agent already has the same
   non-null credential hash, matching the UNIQUE column in Postgres.
2. Config: `agentAuth` becomes `{ mode: "keys" }` or
   `{ mode: "disabled", reason }`. Disabled when `AGENT_ACCESS=off`.
   Local: still seeds the fixture agent when `MCP_DEV_FIXTURE_TOKEN` is set.
3. Deps: build the key authenticator whenever a store exists and agent
   access is not off; otherwise the disabled one.
4. Operation `create_agent` (web only, mutating, not destructive): input
   `{ name, preset, confirm }` as a strict object (so `idempotencyKey` is
   rejected); requires `confirm: true`; validates name and preset. Inside one
   store transaction and NOT through `runMutation` (which stores results):
   check uniqueness of the name among the trip's active agents
   (case-insensitive) and the 25-agent limit; generate the key inside the
   transaction callback, so a retried attempt makes a new one; confirm no
   agent already has its hash; store the agent with the hash and one grant;
   append a content-free audit line. Return
   `{ status: "ok", agent: AgentSummary, key }`. Never log the key.
5. Health reports `agentAccess: "keys"` or `"disabled"`.

Acceptance, all as tests, on both stores where the harness allows:
- The returned key starts with `tpk_`, is 47 characters, and works on
  `/api/mcp` in a production-configured app; the stored record holds only
  its SHA-256; neither `list_agents`, the audit log, nor any later response
  contains the key or its hash.
- Tools offered match the preset; a Read-only key cannot change anything.
- Missing confirmation, bad names, bad presets, a duplicate active name and
  the 26th active agent are refused; an agent principal calling
  `create_agent` is refused.
- After `revoke_agent`, the key gets 401 on its next request; other agents
  are unaffected.
- `AGENT_ACCESS=off` gives 503 even with a valid key; no store gives 503.
- The key in a query string, a cookie, or the website password as a bearer
  get 401.
- OAuth is still never constructed outside tests, and the metadata route
  answers 404 in key mode.
- Authorization header edge cases: wrong scheme, extra spaces, two
  comma-joined values, and an over-long value get 401; a valid key with no
  grant for this trip, or an empty grant, gets 403.
- Name rules: a case-insensitive duplicate of an active agent is refused; a
  revoked agent's name can be reused; the 26th active agent is refused while
  25 revoked ones do not count.
- Simultaneous creates with the same name produce exactly one agent; with
  24 active agents, two simultaneous creates produce exactly one more.
- A creation whose transaction fails part-way leaves no agent, no grant and
  no audit line.
- Nothing stored after creation contains the key: not the idempotency
  records, not the audit log, not any listed field.
- In a deployed configuration, `MCP_DEV_FIXTURE_TOKEN` creates no agent.
- A store that throws during MCP authentication or rate limiting yields the
  fixed 500 with `no-store`, and neither the response nor the logs contain
  the sentinel text from the thrown error.
- `tests/agent-keys.test.ts` is listed in the "postgres" project in
  `vitest.config.mts`, so it runs on both stores.

Check: `bun run check`.

### Task 2: interface (opus-5.5)

Files: `src/ui/MorePanel.tsx`, new `src/ui/AgentKeyDialog.tsx`.

In More, Agents: a **Create agent** button opening a dialog with a name
field and the three presets (Full selected). On success the dialog shows the
key once with a Copy button, the MCP address, the header to use
(`Authorization: Bearer <key>`), and a plain warning that it will not be
shown again. Closing the dialog discards the key. The list shows each
agent's permissions and Revoke. If the request fails without a clear answer
(network error or 5xx), the dialog says the agent may have been created,
refreshes the list, and says to revoke it and create it again.

Check: `bun run check`; manual check deferred to browser QA.

### Task 3: documents (opus-5.5)

`docs/mcp.md` (how to connect an agent with a key, per client where known),
`docs/spec.md`, `README.md`, and the `AGENTS.md` rule on remote agent access.

## Review

gpt-6.1-sol reviews this plan before work starts, and the finished branch
before it merges.
