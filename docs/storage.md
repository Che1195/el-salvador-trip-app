# Storage

Status: **connected 2026-10-01.** Production and preview each run on their
own Neon project, migrated by the owner with `db:migrate`, and each
deployment's health report shows `storage: postgres`. The store's automated
tests still run on an in-process Postgres, not on these databases.

## Two stores, one contract

Both implement `Store` in `src/server/store/types.ts`, and
`tests/store-contract.test.ts` runs the same tests against both.

| Store | Where | Durable |
|---|---|---|
| `MemoryFixtureStore` | Local development and tests. A preview only if `TRIP_FIXTURE_PREVIEW=1` | No: one process's memory, lost on restart, not shared between devices or instances |
| `PostgresStore` | Any environment with `DATABASE_URL` set | Yes |

Production never uses the fixture. The store's constructor, the sample
seeder and the configuration loader each refuse it independently.

## How the Postgres store is tested

The tests run on PGlite, a Postgres compiled to WebAssembly that runs inside
the test process. There is no server, no network and no credential.

- `tests/store-contract.test.ts`: the storage contract on both stores.
- `tests/postgres-store.test.ts`: migrations, the environment marker,
  startup checks, retries, durable rate limits, configuration, the migrate
  command.
- The "postgres" test project reruns the operation, route, MCP and OAuth
  suites with the Postgres store underneath.

What this cannot show: PGlite has one connection, so its transactions never
overlap. Real collisions between concurrent transactions only happen on a
server. The retry logic for them is tested with a scripted database that
fails on cue; it has not met a real serialization failure.

## Design

**Isolation.** Every transaction is SERIALIZABLE. The operations read and
then write (check a revision, count a list, look up an idempotency key), and
serializable isolation makes each of those behave as if nothing else ran at
the same time.

**Retries.** When Postgres aborts a transaction because of a concurrent one
(SQLSTATE 40001 serialization failure, 40P01 deadlock, or 23505 unique
violation from two simultaneous inserts), nothing was kept, so the whole
transaction runs again: up to 5 attempts, with a growing, randomized wait.
Other errors are not retried.

**Stale writes.** Besides the revision check in the operations, the store
itself refuses to save a revision that does not directly follow the stored
one.

**Rate limits.** One row per key per time window, incremented by a single
atomic statement, so the count is shared by every server instance. Windows
older than a day are deleted as new ones open.

**Environment marker.** Each database stores which environment it belongs
to (`meta.data_scope`: production, preview or local). It is written once by
the migrate command and can never be changed to another value. On startup the
app reads it, and `storeMatchesDeployment` in `src/server/deps.ts` refuses a
database whose marker differs from the deployment. A preview given
production's connection string by mistake would refuse to serve.

**Schema version.** The app refuses a database older than the migration
version the code expects (`EXPECTED_SCHEMA_VERSION`) and accepts the same
version or a newer one. Migrations only ever add, so the order for a schema
change is: apply the migration to each database (the running code keeps
working), then deploy the code that needs it. The app never changes the
schema itself.

**TLS.** In deployments, `DATABASE_URL` must say `sslmode=require` (or
stricter), and the app then also verifies the server's certificate
explicitly, rather than relying on how the driver version reads `sslmode`.

**Secrets.** The connection string is read from the deployment's environment
at runtime. It is never logged, returned, or included in an error. Startup
failures log a fixed reason only (`connection_failed`, `schema_missing`,
`schema_behind`, `scope_marker_missing`). The migrate command prints its own refusals
(which hold only migration numbers, file names and environment names) or a
fixed sentence with an error code such as `28P01`. It never prints a
driver's message, stack or detail, since any of them can quote the connection
string, user, host or database name. `tests/migrate-errors.test.ts` runs the
real script to check this.

## Migrations

Files in `db/migrations`, numbered `0001_name.sql`, applied in order. The
runner records a checksum for each and refuses to continue if an applied file
was edited or if the database is ahead of the code. Each file runs in its own
transaction. Migrations hold structure only, never data.

## Recommendation: Neon Postgres, Free plan

Approved by the owner. Checked against
[neon.com/pricing](https://neon.com/pricing) on 2026-09-30: $0 per month, no
credit card; 0.5 GB storage, 100 CU-hours and 5 GB transfer per project per
month; scales to zero after 5 minutes idle; 6-hour restore window. Over a
limit, compute is suspended or writes are blocked until the next month;
nothing is deleted or charged.

Use **two separate Neon projects**, production and preview, each with its own
connection string, set in Vercel for that environment only. Avoid the
integration's automatic preview branches: a branch starts as a copy of
production. The preview database holds fixtures only.

## Setting up a database

For the database owner. Done for both environments on 2026-10-01; kept for
rebuilding or adding an environment. Do preview first (with sample data), then
production (without). The Neon projects already exist; identify them by
project ID, since both have a default branch named "production":

| Environment | Neon project | Project ID |
|---|---|---|
| Preview | trip-planner-development | `muddy-boat-80356130` |
| Production | trip-planner-production | `restless-fire-29986419` |

Two different connection strings are used, and neither is ever pasted into
a chat or committed:

- **Direct** (Neon's Connect dialog with connection pooling off): only for
  running migrations from your terminal.
- **Pooled** (pooling on; the host contains `-pooler`): only for
  `DATABASE_URL` in Vercel, because serverless functions open many short
  connections.

1. In the Neon project, open **Connect**, choose database `neondb`, turn
   connection pooling **off**, and copy the direct connection string.
2. In your own terminal, load it without it being shown or saved in your
   shell history (paste, then press Return):

```bash
read -rs DATABASE_URL && export DATABASE_URL
```

3. Preview what would change. Nothing is written:

```bash
bun run db:migrate -- --scope preview --dry-run
```

4. Apply it. For the preview database, `--seed-sample` also loads the
   fictitious sample trip:

```bash
bun run db:migrate -- --scope preview --seed-sample
```

   For production, use `--scope production --confirm-production`. Sample data
   is refused there.
5. Clear it from the shell:

```bash
unset DATABASE_URL
```

6. Back in **Connect**, turn connection pooling **on** and copy the pooled
   string. Send it straight to Vercel for the matching environment only
   (`preview` or `production`), without it appearing on screen:

```bash
read -rs POOLED && printf '%s' "$POOLED" | vercel env add DATABASE_URL preview --sensitive --yes; unset POOLED
```

   For production, replace `preview` with `production`. A preview also needs
   its own `SESSION_SECRET` and `TRIP_PASSWORD_HASH` (added the same way as
   production's) before anyone can sign in to it.
7. Redeploy that environment. New variables only reach new deployments.
8. Open `/api/health` on the deployment. `"storage": "postgres"` confirms it
   worked. `not_configured` means the app refused the database; the Vercel
   function log names the reason.

A new production database has no trip. The first person to sign in is asked
for the trip's name, destination and dates.
