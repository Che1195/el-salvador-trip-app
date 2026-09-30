<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Rules for this repository

This repository is public. It holds code and fictitious sample data only.

- Never add real trip details: dates, lodging, prices, itinerary, reservation
  references, names, or anything else about an actual trip or person. Sample
  content lives in `src/server/sample-data.ts`, is made up, and is labeled.
- Never add a password, signing key, token, database URL, or `.env` file.
  `.env.example` lists names only. Do not read `.env` files.
- Never put encrypted private data in the repository either.
- Every route that returns or changes trip data must call `requireWebSession`
  (web) or go through the agent authenticator (MCP). Add new routes to the
  table in `tests/routes.test.ts`; the suite fails otherwise.
- New behavior goes in `src/server/operations.ts` so the web app and MCP share
  it. Do not add logic to a route file or to the MCP adapter.
- Agents must not be able to remove records. Do not add a tool or a path that
  lets one, and keep the guard in `commitChange`.
- The in-memory store is a local fixture. Do not make production fall back to it.
- Read [docs/spec.md](docs/spec.md) before starting, and update it when scope,
  a decision, or the next action changes.
- Use bun. Verify with `bun run check`.
