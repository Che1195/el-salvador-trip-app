# Storage

Status: **nothing is provisioned.** The app runs on an in-memory fixture. This
page records the recommendation and what has to happen before real data.

## What runs today

`src/server/store/memory.ts` is a local development fixture. It keeps data in
one process's memory, so data is lost on restart and is not shared between
devices or server instances. It is not the durable cross-device storage the
packing list needs.

- Local development: used by default, seeded with the fictitious sample trip.
- Preview: used only if `TRIP_FIXTURE_PREVIEW=1`. On a serverless host each
  instance has its own memory, so a fixture preview is a demo and may sign you
  out or lose edits between requests.
- Production: never. The store's constructor, the sample seeder and the
  configuration loader each refuse it independently.

## Recommendation: Neon Postgres, Free plan

Checked against [neon.com/pricing](https://neon.com/pricing) on 2026-09-30.

| | Neon Free |
|---|---|
| Price | $0 per month, no credit card |
| Projects | 100 |
| Storage | 0.5 GB per project |
| Compute | 100 CU-hours per project per month |
| Idle behavior | Scales to zero after 5 minutes; this cannot be turned off, so the first request after idle is slower |
| Data transfer | 5 GB per project |
| Restore window | 6 hours |
| Branches | 10 per project |
| Over a limit | Compute is suspended, or writes are blocked, until the next month. Data is not deleted and nothing is charged |

A trip's data is a few megabytes, so the limits are not a concern. The 6-hour
restore window is short: the app's own change history (every edit keeps the
previous version) is the main recovery tool, not the database's.

Access it needs: a Neon account and acceptance of Neon's terms. That is a step
for the account owner. No one else needs database access; the second traveler
uses the app, not the database.

## Keeping preview away from production

Use **two separate Neon projects**, one for production and one for preview,
each with its own connection string, set in Vercel for that environment only.

Avoid the Vercel-Neon integration's automatic preview branches. A Neon branch
starts as a copy of its parent, so every preview deployment would hold a copy
of the real trip.

The app enforces the separation itself as well. Each database carries a
`data_scope` marker (`db/schema.sql`, table `meta`). A store reports that
scope, and `storeMatchesDeployment` in `src/server/deps.ts` refuses any store
whose scope differs from the deployment's. A preview given production's
connection string by mistake would refuse to serve.

The preview database holds fixtures only.

## What is left to build

1. A Postgres implementation of the `Store` interface
   (`src/server/store/types.ts`), using `db/schema.sql`. Transactions must be
   serializable or lock the rows they read, because the operations rely on
   read-then-write being atomic.
2. Tests for it against a real Postgres, run on the preview project.
3. A private, one-time seed of the real trip. It is never committed.

`db/schema.sql` is a draft. It has not been run anywhere.
