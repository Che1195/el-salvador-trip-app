-- DRAFT. Not applied to any database, and no code uses it yet.
--
-- This is the Postgres shape the Store interface in src/server/store/types.ts
-- is designed to map onto once private storage is approved and connected.
-- It holds no data. Real trip content is only ever written by the running
-- app into a private database; it never appears in this repository.

create table meta (
  key   text primary key,
  value text not null
);
-- One row, written once when a database is created:
--   ('data_scope', 'production' | 'preview')
-- The app reads it on startup and refuses to serve if it does not match the
-- deployment it is running in. That is what keeps a preview off production data.

create table entities (
  trip_id    text        not null,
  id         text        not null,
  kind       text        not null check (kind in ('trip','itinerary','packing','budget','bookings','notes')),
  revision   integer     not null check (revision >= 1),
  data       jsonb       not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  updated_by text        not null,
  deleted_at timestamptz,
  primary key (trip_id, id)
);
create index entities_by_kind on entities (trip_id, kind) where deleted_at is null;

-- One row per state transition. `before` is the full prior record.
create table changes (
  trip_id         text        not null,
  id              text        not null,
  batch_id        text        not null,
  entity_id       text        not null,
  kind            text        not null,
  action          text        not null check (action in ('create','update','remove','restore','undo')),
  before          jsonb,
  result_revision integer     not null,
  at              timestamptz not null,
  actor_id        text        not null,
  primary key (trip_id, id)
);
create index changes_by_batch on changes (trip_id, batch_id, at);

-- Ids and outcomes only. No trip content.
create table audit_log (
  trip_id     text        not null,
  id          text        not null,
  at          timestamptz not null,
  actor_type  text        not null check (actor_type in ('web','agent','system')),
  actor_id    text        not null,
  actor_label text        not null,
  op          text        not null,
  kind        text,
  entity_id   text,
  batch_id    text,
  change_id   text,
  outcome     text        not null,
  primary key (trip_id, id)
);
create index audit_recent on audit_log (trip_id, at desc);

create table idempotency_keys (
  trip_id      text        not null,
  principal_id text        not null,
  key          text        not null,
  request_hash text        not null,
  result       jsonb       not null,
  at           timestamptz not null,
  primary key (trip_id, principal_id, key)
);

create table sessions (
  id         text primary key,
  trip_id    text        not null,
  label      text        not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  epoch      integer     not null
);

create table session_epochs (
  trip_id text primary key,
  epoch   integer not null
);

create table agents (
  id              text primary key,
  name            text        not null,
  credential_hash text unique,
  created_at      timestamptz not null,
  revoked_at      timestamptz
);

create table agent_grants (
  agent_id text   not null references agents (id),
  trip_id  text   not null,
  scopes   text[] not null,
  primary key (agent_id, trip_id)
);

create table rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        integer     not null,
  primary key (key, window_start)
);
