-- 0002_removal_requests
--
-- Requests from agents to remove an item, which a person approves or rejects
-- in the app. A new table only: nothing that version-1 code reads or writes
-- changes, so this migration can be applied while that code is serving.
--
-- A request's target and wording never change after it is created; only its
-- status, decided time and decided-by are set, once, when it is decided.

create table removal_requests (
  trip_id           text        not null,
  id                text        not null,
  agent_id          text        not null,
  agent_label       text        not null,
  kind              text        not null check (kind in ('itinerary', 'packing', 'budget', 'bookings', 'notes')),
  entity_id         text        not null,
  expected_revision integer     not null check (expected_revision >= 1),
  item_label        text        not null,
  reason            text        not null default '',
  status            text        not null check (status in ('pending', 'approved', 'rejected', 'outdated', 'expired')),
  created_at        timestamptz not null,
  decided_at        timestamptz,
  decided_by        text,
  primary key (trip_id, id)
);
create index removal_requests_by_status on removal_requests (trip_id, status, created_at);
create index removal_requests_by_item on removal_requests (trip_id, entity_id);
