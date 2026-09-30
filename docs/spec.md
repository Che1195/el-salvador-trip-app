# Trip planner: specification

Status: initial build, local fixture only. Last updated 2026-09-30.

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
- A real database. The app runs on a labeled in-memory fixture.
- Remote agent access. It stays off until an authorization provider is approved.
- Any real trip content, password, key, token, or database credential.
- Per-person accounts. The shared password gives no way to tell the two people
  apart beyond the device name each types at sign-in.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | Next.js 16, Tailwind 4, TypeScript, bun, Vercel | Requested |
| Storage | New Neon Postgres, Free plan; two separate projects (production, preview) | $0, no card, fits the data size. Approved by the owner; not yet connected |
| Hosting | Vercel, Hobby plan. Project created and linked through the existing GitHub integration; no environment variables set | Requested |
| Preview data | Fixtures only | A Neon preview branch would be a copy of production |
| Web auth | Shared password (scrypt hash in env), signed cookie plus a server-side session record | Sign-out and "sign out every device" must really revoke |
| Agent auth | Separate per-agent records with scopes; shared password is never agent auth | Revoking one agent must not affect people or other agents |
| Agent removals | Not available to agents at all | A token the agent can echo is not a person's consent |
| Conflict handling | Per-item revision; stale edits are refused | Two phones and several agents write concurrently |
| Deletes | Soft delete to a trash, with restore | Every mistake must be recoverable |

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

## Open gates

Each needs a decision or an action from the owner before work continues.

1. **Storage connection.** Neon Free is approved; the secure sign-in and
   connection are being coordinated separately. Nothing is provisioned. Next:
   write the Postgres store against `db/schema.sql` and test it. See
   [storage.md](storage.md).
2. **Production secrets.** `SESSION_SECRET` and `TRIP_PASSWORD_HASH` are set by
   the owner, never by an agent. See the README.
3. **Agent authorization provider.** Required before any remote agent can
   connect. ChatGPT needs OAuth 2.1. See [mcp.md](mcp.md).
4. **Human approval path for agent removals.** Agents cannot remove items
   until a person can approve each removal in the app.
5. **Real trip content.** Entered in the app, or seeded privately, only after
   gates 1 and 2.
6. **Browser check.** No browser test has been run. The interface has only
   been exercised over HTTP.

## Accepted risks

- One shared password. Anyone who has it can read and edit the trip. Revisit
  if a third person needs access.
- A global cap on sign-in attempts means a flood of wrong guesses can block
  sign-in for up to 15 minutes. Signed-in devices keep working.
- Trash is never emptied automatically. Revisit if the 0.5 GB limit matters.
