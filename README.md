# Trip planner

A private, mobile-first planner for one shared trip: itinerary, packing list,
budget, bookings and notes. People use it in the browser. Their AI agents use
the same operations through an MCP server (Model Context Protocol, the
standard agents use to call an app's tools).

**This repository holds code and fictitious sample data only.** Real trip
details are typed into the running app and live in private server storage.
They are never committed, and neither is any password, key or token.

## Status

| Part | State |
|---|---|
| Web app, domain rules, MCP server | Built. Tested on the in-memory fixture and on an in-process Postgres |
| Durable storage | Postgres store and migrations built. No database connected yet; see [docs/storage.md](docs/storage.md) |
| Production sign-in | Secrets set. Sign-in starts working once a database is connected |
| Remote agent access | Off. Every deployed environment answers 503 on `/api/mcp`. OAuth token checks are built and tested against a fake provider only |
| ChatGPT, Muse or other hosted agents | Not verified. See [docs/mcp.md](docs/mcp.md) |
| Hosting | Vercel project linked to this repository, with no secrets and no database. Deployments show a "not set up yet" page and refuse every data request |
| Browser testing | Not done. The interface has been exercised over HTTP only |

What was agreed, and what is still open, is in [docs/spec.md](docs/spec.md).

## Run it locally

```bash
bun install
```

```bash
bun run dev
```

Open http://localhost:3000 and sign in with the local fixture password shown
on the sign-in page. You get a sample trip with made-up places and prices.
Local data lives in memory: it resets when the server restarts and is not
shared between devices.

## Checks

```bash
bun run check
```

That runs the typecheck, lint and the test suite. The suite runs twice where
it matters: once on the in-memory fixture and once on PGlite, a Postgres that
runs inside the test process, so no database server or credential is needed.
`bun run build` builds for production.

## How it is protected

- **No client-side gate.** Pages and every API route check the session on the
  server before returning anything.
- **Sessions.** A signed cookie (HttpOnly, SameSite, Secure in deployments)
  plus a server-side record. Sessions expire after 14 days. Signing out ends
  the session on the server, "sign out every device" ends all of them, and
  changing the password or the signing key does too.
- **Cross-site requests.** Anything that changes data must come from a trusted
  origin, be same-origin according to the browser, and carry a custom header.
- **Limits.** Request bodies are size limited, input is validated, and sign-in
  and operations are rate limited.
- **Nothing private is cached or logged.** Responses are `no-store`, pages are
  rendered per request, there is no service worker, errors return a code and a
  fixed message, and the activity log stores ids and outcomes only.
- **Fail closed.** A deployment without its secrets or its store refuses
  requests. The in-memory fixture, the fixture password and the fixture agent
  cannot run in production.
- **Preview cannot touch production.** Each environment has its own storage,
  and a store is refused if it belongs to a different environment.
- **Agents.** Each agent has its own revocable record and scopes. The shared
  password is not an agent credential. Agents cannot remove anything.

## Environment variables

Names and meanings are in [.env.example](.env.example). Set values in the
hosting provider's settings, separately for Production and Preview. Do not
create a committed `.env` file.

The owner sets the two secrets, by hand:

1. `SESSION_SECRET`: 32 or more random characters. `openssl rand -base64 48`
   produces one.
2. `TRIP_PASSWORD_HASH`: run `bun run hash-password` in a terminal, type the
   password when asked (it is not shown), and copy the printed hash.

## Layout

| Path | Holds |
|---|---|
| `src/domain` | Shared types and budget math. No server code |
| `src/server/operations.ts` | Every trip operation, used by the web API and by MCP |
| `src/server/handlers.ts` | Web API request handlers |
| `src/server/mcp` | MCP protocol adapter and HTTP entry point |
| `src/server/store` | Storage interface, the in-memory fixture, the Postgres store and the migration runner |
| `src/server/oauth` | Access-token checks and OAuth metadata for agents (off in deployments) |
| `src/server/sample-data.ts` | The fictitious sample trip |
| `src/ui` | The interface |
| `db/migrations` | Numbered schema migrations, applied by `bun run db:migrate` |
| `tests` | Test suite |
