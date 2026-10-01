# Trip planner: specification

Status: initial build merged to `main` (PR #1, 2026-09-30). Production is
live at https://el-salvador-trip-app.vercel.app on its own Neon Postgres
database, with sign-in configured (2026-10-01). Remote agent access stays off.
Last updated 2026-10-01.

This file is the single record of what was agreed. Update it whenever scope,
a decision, or the next action changes.

## Intent

A private, mobile-first planner for one shared trip, used by two people and by
their AI agents acting for them. It may later hold other trips for the same
two people.

## In scope for this build

- One trip, one interface: itinerary, packing, budget, bookings, notes.
- Every item that can be reserved carries a status: **considering** (an
  option), **selected** (chosen, not reserved), or **booked** (reserved or
  bought). Selected and booked are never merged.
- Packing items are shared checkboxes.
- Budget lines are quantity times unit price, with totals calculated by the
  app in whole cents.
- Sign-in with one shared password, checked on the server.
- An MCP server (Model Context Protocol, the standard agents use to call an
  app's tools) exposing the same operations the web app uses.
- Fictitious, visibly labeled sample data only.

## Out of scope for this build

- Managing several trips. Records, sessions and agent grants all carry a
  `tripId`, and the trip's title, destination and dates are an editable record
  rather than code, but there is one trip and no trip switcher.
- Remote agent access. It stays off until an OAuth integration is verified.
- Any real trip content, password, key, token, or database credential.
- Applying migrations to a hosted database, or reading its connection string.
- Choosing or connecting an OAuth authorization server, and enrolling OAuth
  agents. The token-checking side is built and tested against a fake.
- Per-person accounts. The shared password gives no way to tell the two people
  apart beyond the device name each types at sign-in.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | Next.js 16, Tailwind 4, TypeScript, bun, Vercel | Requested |
| Storage | Neon Postgres, Free plan; two separate projects: trip-planner-production (`restless-fire-29986419`) and trip-planner-development (`muddy-boat-80356130`, preview) | $0, no card, fits the data size. Approved by the owner; connected 2026-10-01 |
| Database connections | Direct connection for migrations, run by the owner; pooled connection for Vercel's `DATABASE_URL`. Each string only in its own Vercel environment | Migrations need one stable session; serverless functions open many short ones |
| Hosting | Vercel, Hobby plan, linked through the existing GitHub integration. `main` deploys to production; other branches get previews. No environment variables set | Requested |
| Code review | The owner reviews the collaborator's pull requests. The owner's own pull requests may merge without a reviewer | Owner's decision |
| Preview data | Fixtures only | A Neon preview branch would be a copy of production |
| Web auth | Shared password (scrypt hash in env), signed cookie plus a server-side session record | Sign-out and "sign out every device" must really revoke |
| Agent auth | Separate per-agent records with scopes; shared password is never agent auth | Revoking one agent must not affect people or other agents |
| Agent keys | A signed-in person creates each agent in the app and gets a `tpk_` key once; only its SHA-256 is stored; presets: everything, packing only, read only; at most 25 active per trip. All agents off: `AGENT_ACCESS=off` plus a redeploy. Plan: [plans/2026-10-01-agent-keys.md](plans/2026-10-01-agent-keys.md) | Lets Muse, Grok, Claude Code and Codex agents connect now; ChatGPT still needs OAuth |
| Agent removals | Not available to agents at all | A token the agent can echo is not a person's consent |
| Conflict handling | Per-item revision; stale edits are refused | Two phones and several agents write concurrently |
| Deletes | Soft delete to a trash, with restore | Every mistake must be recoverable |
| Postgres access | `pg` driver, SERIALIZABLE transactions, retried on 40001, 40P01 and 23505 | Read-then-write operations must not interleave |
| Store tests | PGlite (Postgres in WebAssembly, in the test process) | No server or credential needed. Cannot produce real concurrent collisions |
| Schema | Numbered migrations with checksums; the app checks the version and never migrates itself | A deploy cannot silently change the schema |
| Environment separation | A write-once marker inside each database, checked at startup | Holds even if a connection string is pasted into the wrong environment |
| Agent OAuth | Resource-server checks with `jose`; identity is issuer + client + user; token scopes can only narrow a grant | MCP authorization spec; one revocable record per assistant |
| First run | A signed-in person on an empty database is asked for the trip's details | Production needs no seed script |

## Acceptance criteria and where each is checked

| Criterion | Check |
|---|---|
| Every private route refuses a request without a valid session | `tests/routes.test.ts`, which also fails if a new route file is not listed |
| Tampered, expired, signed-out and revoked sessions are refused | `tests/routes.test.ts`, `tests/session.test.ts` |
| Cross-site requests cannot change anything | `tests/routes.test.ts` |
| Input is validated and size-limited; sign-in and operations are rate limited | `tests/routes.test.ts` |
| Production refuses to run on fixtures or without secrets | `tests/config.test.ts` |
| A store of one environment is refused by another | `tests/config.test.ts` |
| Agent scopes, revocation, audit, idempotency | `tests/operations.test.ts`, `tests/mcp.test.ts` |
| Agents cannot remove a record by any path | `tests/operations.test.ts`, `tests/mcp.test.ts` |
| Concurrent packing writes lose nothing | `tests/operations.test.ts` |
| Budget totals are exact | `tests/budget.test.ts` |
| Both stores behave the same | `tests/store-contract.test.ts`, plus the "postgres" test project rerunning the operation, route, MCP and OAuth suites |
| Migrations apply once, refuse edits, and roll back on failure | `tests/postgres-store.test.ts` |
| A database of the wrong environment, or schema version, is refused | `tests/postgres-store.test.ts` |
| Collisions are retried; other errors are not | `tests/postgres-store.test.ts` (scripted database) |
| Rate limits are shared across instances | `tests/postgres-store.test.ts` |
| Tokens are checked for signature, issuer, audience, expiry, algorithm | `tests/oauth.test.ts` |
| OAuth is never constructed in a deployed environment | `tests/oauth.test.ts`, `tests/agent-keys.test.ts` |
| Agent keys: shown once, stored only as SHA-256, scoped by preset, revocable, refused anywhere but the Authorization header, closed until a key exists | `tests/agent-keys.test.ts`, on both stores |

## Open gates

Each needs a decision or an action from the owner before work continues.

1. **Storage connection.** Done 2026-10-01. The owner migrated both databases
   from their own terminal and set each pooled string in its own Vercel
   environment. Preview: schema 1, marker `preview`, a trip present (expected
   to be the fictitious sample). Production: schema 1, marker `production`, no
   trip yet. Production health reports `storage: postgres` and `signIn: ready`;
   the preview reports `storage: postgres`.
2. **Production secrets.** Done 2026-10-01: the owner set `TRIP_PASSWORD_HASH`
   and `SESSION_SECRET` for Production in Vercel from their own terminal, and
   production's `/api/health` now reports `"signIn":"ready"`. Secrets are
   only ever set by the owner, never by an agent.
3. **Agent access.** Per-agent keys are built (2026-10-01): agents that can
   send a bearer header connect with a key created in the app. Still needed
   for ChatGPT (Nova): OAuth, meaning choose a provider, build enrollment,
   wire configuration, and prove a real connection. No hosted agent has
   connected yet. See [mcp.md](mcp.md).
4. **Human approval path for agent removals.** Agents cannot remove items
   until a person can approve each removal in the app.
5. **Real trip content.** Entered in the app, or seeded privately, only after
   gates 1 and 2.
6. **Browser check.** No browser test has been run. The interface has only
   been exercised over HTTP.
7. **Hosting.** Production is live and public at
   https://el-salvador-trip-app.vercel.app. With no environment variables and
   no database it fails closed: `/api/health` reports sign-in, storage and
   agent access all off, the home page says the planner is not set up yet,
   and `/api/trip` and `/api/mcp` answer 503. It stays that way until gates 1
   and 2 are done. Preview URLs sit behind Vercel sign-in, so only the Vercel
   account owner can open them. Whether commits authored by the collaborator
   deploy on the Hobby plan is untested.

## Next action

The owner signs in to production and enters the trip's details (the app asks
on first sign-in). Then: preview sign-in secrets and browser QA on the
preview (gate 6), and real trip content (gate 5).

## Accepted risks

- One shared password. Anyone who has it can read and edit the trip. Revisit
  if a third person needs access.
- A global cap on sign-in attempts means a flood of wrong guesses can block
  sign-in for up to 15 minutes. Signed-in devices keep working.
- Trash is never emptied automatically. Revisit if the 0.5 GB limit matters.
