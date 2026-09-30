-- 0001_initial
--
-- Tables behind the Store interface in src/server/store/types.ts.
-- Applied files are never edited: the runner records a checksum for each and
-- refuses to continue if one changes. Add a new numbered file instead.
--
-- This file creates structure only. Trip content is written by the running
-- app into a private database and never appears in this repository.

-- 'data_scope' says which environment this database belongs to (production,
-- preview or local). It is written once and never changed. The app refuses to
-- serve from a database whose scope differs from the deployment it runs in.
create table meta (
  key   text primary key,
  value text not null
);

create table entities (
  trip_id    text        not null,
  id         text        not null,
  kind       text        not null check (kind in ('trip', 'itinerary', 'packing', 'budget', 'bookings', 'notes')),
  revision   integer     not null check (revision >= 1),
  data       jsonb       not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  updated_by text        not null,
  deleted_at timestamptz,
  primary key (trip_id, id)
);
create index entities_by_kind on entities (trip_id, kind);

-- One row per state transition. "before" is the full prior record, or null
-- when the change created the record.
create table changes (
  seq             bigint generated always as identity primary key,
  trip_id         text        not null,
  id              text        not null,
  batch_id        text        not null,
  entity_id       text        not null,
  kind            text        not null,
  action          text        not null check (action in ('create', 'update', 'remove', 'restore', 'undo')),
  before          jsonb,
  result_revision integer     not null,
  at              timestamptz not null,
  actor_id        text        not null,
  unique (trip_id, id)
);
create index changes_by_batch on changes (trip_id, batch_id, seq);

-- Ids and outcomes only. No trip content.
create table audit_log (
  seq         bigint generated always as identity primary key,
  trip_id     text        not null,
  id          text        not null,
  at          timestamptz not null,
  actor_type  text        not null check (actor_type in ('web', 'agent', 'system')),
  actor_id    text        not null,
  actor_label text        not null,
  op          text        not null,
  kind        text,
  entity_id   text,
  batch_id    text,
  change_id   text,
  outcome     text        not null
);
create index audit_recent on audit_log (trip_id, seq desc);

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

-- An agent is identified either by the hash of an opaque credential (local
-- fixture) or by an identity asserted by an OAuth authorization server.
create table agents (
  id              text primary key,
  name            text        not null,
  credential_hash text unique,
  oauth_issuer    text,
  oauth_subject   text,
  created_at      timestamptz not null,
  revoked_at      timestamptz,
  check ((oauth_issuer is null) = (oauth_subject is null))
);
create unique index agents_by_oauth_identity on agents (oauth_issuer, oauth_subject)
  where oauth_issuer is not null;

create table agent_grants (
  agent_id text  not null references agents (id) on delete cascade,
  trip_id  text  not null,
  scopes   jsonb not null,
  primary key (agent_id, trip_id)
);
create index agent_grants_by_trip on agent_grants (trip_id);

-- Fixed-window counters. One row per key per window.
create table rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        integer     not null,
  primary key (key, window_start)
);
create index rate_limits_by_window on rate_limits (window_start);
