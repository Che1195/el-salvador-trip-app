// The trip's operations. The web API and the MCP adapter both call
// `executeOperation`, so validation, authorization, conflict checks,
// idempotency, confirmation, change history and the audit log behave the same
// no matter who is acting.
//
// Authorization comes only from `ctx.principal`, which the caller derives
// from a verified session or agent credential. Nothing in an operation's
// input, and nothing stored in trip content, can grant access.
//
// Agents cannot remove anything. A token an agent can read and send back is
// not a person's consent, so until a real human approval path exists, every
// operation that can take a record out of the trip is for people in the app
// only, and `commitChange` refuses any agent write that would do it by
// another route (for example by undoing a creation).

import "server-only";
import { z } from "zod";
import { computeBudgetTotals } from "@/domain/budget";
import {
  SECTIONS,
  type ActivityEntry,
  type AgentSummary,
  type BudgetData,
  type ChangeAction,
  type EntityKind,
  type Item,
  type Scope,
  type Section,
  type TrashEntry,
  type TripData,
  type TripSnapshot,
} from "@/domain/model";
import { DomainError } from "./errors";
import { newId, sha256Hex, stableStringify } from "./hash";
import {
  DATA_KEYS,
  DATA_SCHEMAS,
  dataObjectSchema,
  idSchema,
  idempotencyKeySchema,
  issuesOf,
  revisionSchema,
  sectionSchema,
} from "./schemas";
import type { AuditRecord, JsonObject, Store, StoredEntity, StoreTx } from "./store/types";

export type Principal =
  | { type: "web"; id: string; label: string; tripId: string }
  | { type: "agent"; id: string; label: string; tripId: string; scopes: readonly Scope[] };

export interface OpContext {
  principal: Principal;
  tripId: string;
  store: Store;
  now: Date;
}

export interface OperationDef {
  name: string;
  title: string;
  description: string;
  /** "web" operations are never offered to agents. */
  audience: "all" | "web";
  mutating: boolean;
  destructive: boolean;
  /** An agent needs at least one of these to see or call the operation. */
  anyOfScopes: readonly Scope[];
  input: z.ZodObject;
  execute(ctx: OpContext, rawInput: unknown): Promise<JsonObject>;
}

export const MAX_ITEMS_PER_SECTION = 300;

// ---------------------------------------------------------------------------
// Authorization

function canRead(principal: Principal, kind: EntityKind): boolean {
  if (principal.type === "web") return true;
  if (principal.scopes.includes("trip:read")) return true;
  return kind === "packing" && principal.scopes.includes("packing:read");
}

function canWrite(principal: Principal, kind: EntityKind): boolean {
  if (principal.type === "web") return true;
  if (principal.scopes.includes("trip:write")) return true;
  return kind === "packing" && principal.scopes.includes("packing:write");
}

function assertCanRead(ctx: OpContext, kind: EntityKind): void {
  if (!canRead(ctx.principal, kind)) {
    throw new DomainError("insufficient_scope", `This credential cannot read ${kind}.`);
  }
}

function assertCanWrite(ctx: OpContext, kind: EntityKind): void {
  if (!canWrite(ctx.principal, kind)) {
    throw new DomainError("insufficient_scope", `This credential cannot change ${kind}.`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

function iso(now: Date): string {
  return now.toISOString();
}

/** One batch per actor per UTC day, so "undo what this agent did today" is one id. */
function batchIdFor(ctx: OpContext): string {
  return `${ctx.principal.id}.${iso(ctx.now).slice(0, 10)}`;
}

function toItem(entity: StoredEntity, principal: Principal): Item<JsonObject> {
  let data = entity.data;
  if (entity.kind === "bookings" && principal.type === "agent") {
    // Reservation references stay with the people travelling.
    const { confirmation, ...rest } = data;
    data = { ...rest, hasConfirmation: typeof confirmation === "string" && confirmation !== "" };
  }
  return {
    id: entity.id,
    revision: entity.revision,
    updatedAt: entity.updatedAt,
    updatedBy: entity.updatedBy,
    data,
  };
}

function labelOf(entity: StoredEntity): string {
  const { title, label, name } = entity.data;
  for (const candidate of [title, label, name]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return entity.id;
}

function validateData(kind: EntityKind, data: unknown): JsonObject {
  const parsed = DATA_SCHEMAS[kind].safeParse(data);
  if (!parsed.success) {
    throw new DomainError("validation_failed", "Some fields are not valid.", {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data as JsonObject;
}

function refuseAgentConfirmationField(ctx: OpContext, kind: EntityKind, data: JsonObject): void {
  if (ctx.principal.type === "agent" && kind === "bookings" && "confirmation" in data) {
    throw new DomainError("validation_failed", "Some fields are not valid.", {
      issues: [{ path: "confirmation", message: "Reservation references can only be set in the app." }],
    });
  }
}

async function appendAudit(
  tx: StoreTx,
  ctx: OpContext,
  op: string,
  fields: {
    outcome: string;
    kind?: EntityKind | null;
    entityId?: string | null;
    changeId?: string | null;
  },
): Promise<void> {
  const entry: AuditRecord = {
    tripId: ctx.tripId,
    id: newId("aud"),
    at: iso(ctx.now),
    actorType: ctx.principal.type,
    actorId: ctx.principal.id,
    actorLabel: ctx.principal.label,
    op,
    kind: fields.kind ?? null,
    entityId: fields.entityId ?? null,
    batchId: batchIdFor(ctx),
    changeId: fields.changeId ?? null,
    outcome: fields.outcome,
  };
  await tx.appendAudit(entry);
}

interface Committed {
  entity: StoredEntity;
  changeId: string;
  batchId: string;
}

/**
 * Saves a new revision of a record. The snapshot of the previous state, the
 * record itself and the audit line are written in the caller's transaction,
 * so either all of them exist or none do.
 */
async function commitChange(
  tx: StoreTx,
  ctx: OpContext,
  op: string,
  args: {
    before: StoredEntity | null;
    id: string;
    kind: EntityKind;
    data: JsonObject;
    deletedAt: string | null;
    action: ChangeAction;
  },
): Promise<Committed> {
  const removes = args.deletedAt !== null && (args.before === null || args.before.deletedAt === null);
  if (removes && ctx.principal.type !== "web") {
    throw new DomainError("forbidden", "Only a person in the app can remove items.");
  }
  if (args.kind === "trip" && args.deletedAt !== null) {
    throw new DomainError("forbidden", "The trip itself cannot be removed.");
  }
  const at = iso(ctx.now);
  const entity: StoredEntity = {
    tripId: ctx.tripId,
    id: args.id,
    kind: args.kind,
    revision: (args.before?.revision ?? 0) + 1,
    data: args.data,
    createdAt: args.before?.createdAt ?? at,
    updatedAt: at,
    updatedBy: ctx.principal.label,
    deletedAt: args.deletedAt,
  };
  const changeId = newId("chg");
  const batchId = batchIdFor(ctx);
  await tx.putEntity(entity);
  await tx.appendChange({
    tripId: ctx.tripId,
    id: changeId,
    batchId,
    entityId: entity.id,
    kind: entity.kind,
    action: args.action,
    before: args.before,
    resultRevision: entity.revision,
    at,
    actorId: ctx.principal.id,
  });
  await appendAudit(tx, ctx, op, {
    outcome: "ok",
    kind: entity.kind,
    entityId: entity.id,
    changeId,
  });
  return { entity, changeId, batchId };
}

function changed(ctx: OpContext, committed: Committed): JsonObject {
  return {
    status: "ok",
    changed: true,
    item: toItem(committed.entity, ctx.principal),
    changeId: committed.changeId,
    batchId: committed.batchId,
  };
}

function unchanged(ctx: OpContext, entity: StoredEntity): JsonObject {
  return { status: "ok", changed: false, item: toItem(entity, ctx.principal) };
}

function assertRevision(entity: StoredEntity, expectedRevision: number): void {
  if (entity.revision !== expectedRevision) {
    throw new DomainError(
      "conflict",
      "This item changed since you last read it. Read it again, then retry.",
      { id: entity.id, expectedRevision, currentRevision: entity.revision },
    );
  }
}

async function loadLive(tx: StoreTx, ctx: OpContext, kind: EntityKind, id: string) {
  const entity = await tx.getEntity(ctx.tripId, id);
  if (!entity || entity.kind !== kind || entity.deletedAt !== null) {
    throw new DomainError("not_found", "No such item.", { id });
  }
  return entity;
}

const CONTROL_FIELDS = ["idempotencyKey", "confirm"] as const;

function withoutControlFields(input: JsonObject): JsonObject {
  const rest: JsonObject = { ...input };
  for (const field of CONTROL_FIELDS) delete rest[field];
  return rest;
}

/**
 * Wraps a write in one transaction with idempotency. A repeated call with the
 * same key and the same arguments returns the first result and changes
 * nothing; the same key with different arguments is refused.
 */
async function runMutation(
  ctx: OpContext,
  op: string,
  input: JsonObject & { idempotencyKey?: string | undefined },
  body: (tx: StoreTx) => Promise<JsonObject>,
): Promise<JsonObject> {
  const idempotencyKey = input.idempotencyKey;
  if (ctx.principal.type === "agent" && !idempotencyKey) {
    throw new DomainError("validation_failed", "Some fields are not valid.", {
      issues: [{ path: "idempotencyKey", message: "Agents must send one with every change." }],
    });
  }
  const requestHash = sha256Hex(stableStringify({ op, input: withoutControlFields(input) }));

  return ctx.store.transaction(async (tx) => {
    if (idempotencyKey) {
      const prior = await tx.getIdempotency(ctx.tripId, ctx.principal.id, idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new DomainError(
            "idempotency_key_reused",
            "This idempotencyKey was already used for a different request.",
          );
        }
        return { ...prior.result, idempotentReplay: true };
      }
    }
    const result = await body(tx);
    if (idempotencyKey && result.status === "ok") {
      await tx.putIdempotency({
        tripId: ctx.tripId,
        principalId: ctx.principal.id,
        key: idempotencyKey,
        requestHash,
        result,
        at: iso(ctx.now),
      });
    }
    return result;
  });
}

/**
 * Gate for destructive operations. They are only reachable from the app, and
 * the person must have confirmed (the UI asks first and then sends
 * `confirm: true`). An agent cannot satisfy this, whatever it sends.
 */
function requirePersonConfirmation(ctx: OpContext, confirm: boolean | undefined): void {
  if (ctx.principal.type !== "web") {
    throw new DomainError("forbidden", "Only a person in the app can do this.");
  }
  if (confirm !== true) {
    throw new DomainError("confirmation_required", "Confirm this action to continue.");
  }
}

function refuseAgentForce(ctx: OpContext, force: boolean | undefined): void {
  if (force && ctx.principal.type === "agent") {
    throw new DomainError("forbidden", "Only a person in the app can override a conflict.");
  }
}

// ---------------------------------------------------------------------------
// Reads

function bySortKey<T>(keyOf: (value: T) => string) {
  return (a: T, b: T) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value !== "" ? value : fallback;

const SORT_KEYS: Record<Section, (entity: StoredEntity) => string> = {
  itinerary: (e) => `${text(e.data.day, "")} ${text(e.data.startTime, "99:99")} ${e.createdAt} ${e.id}`,
  packing: (e) =>
    `${text(e.data.category, "￿").toLowerCase()} ${text(e.data.label, "").toLowerCase()} ${e.id}`,
  budget: (e) => `${e.createdAt} ${e.id}`,
  bookings: (e) => `${text(e.data.startDate, "9999")} ${e.createdAt} ${e.id}`,
  notes: (e) => `${e.createdAt} ${e.id}`,
};

async function listSection(tx: StoreTx, ctx: OpContext, section: Section) {
  const entities = await tx.listEntities(ctx.tripId, section);
  return entities.sort(bySortKey(SORT_KEYS[section])).map((e) => toItem(e, ctx.principal));
}

async function loadTrip(tx: StoreTx, ctx: OpContext): Promise<StoredEntity> {
  const trip = await tx.getEntity(ctx.tripId, ctx.tripId);
  if (!trip || trip.kind !== "trip") {
    throw new DomainError("not_found", "This trip has not been set up yet.");
  }
  return trip;
}

async function readSnapshot(tx: StoreTx, ctx: OpContext): Promise<JsonObject> {
  const trip = await loadTrip(tx, ctx);
  const [itinerary, packing, lines, bookings, notes] = await Promise.all([
    listSection(tx, ctx, "itinerary"),
    listSection(tx, ctx, "packing"),
    listSection(tx, ctx, "budget"),
    listSection(tx, ctx, "bookings"),
    listSection(tx, ctx, "notes"),
  ]);
  const totals = computeBudgetTotals(
    lines.map((line) => line.data as unknown as BudgetData),
    (trip.data as unknown as TripData).travelers,
  );
  return {
    tripId: ctx.tripId,
    trip: toItem(trip, ctx.principal),
    itinerary,
    packing,
    budget: { lines, totals },
    bookings,
    notes,
    storage: { kind: ctx.store.kind, durable: ctx.store.durable },
  };
}

/** Typed snapshot for the app's own pages. Records were validated when saved. */
export async function getTripSnapshot(ctx: OpContext): Promise<TripSnapshot> {
  const snapshot = await executeOperation(ctx, "get_trip", {});
  return snapshot as unknown as TripSnapshot;
}

// ---------------------------------------------------------------------------
// Operation definitions

function defineOp<S extends z.ZodObject>(
  def: Omit<OperationDef, "execute" | "input"> & {
    input: S;
    run: (ctx: OpContext, input: z.infer<S>) => Promise<JsonObject>;
  },
): OperationDef {
  const { run, ...rest } = def;
  return {
    ...rest,
    async execute(ctx, rawInput) {
      const parsed = def.input.safeParse(rawInput ?? {});
      if (!parsed.success) {
        throw new DomainError("validation_failed", "Some fields are not valid.", {
          issues: issuesOf(parsed.error),
        });
      }
      return run(ctx, parsed.data);
    },
  };
}

const idempotencyKey = idempotencyKeySchema
  .optional()
  .describe("Your own unique id for this change. Retrying with the same id applies it once.");
const expectedRevision = revisionSchema.describe(
  "The item's revision from your latest read. The change is refused if the item has moved on.",
);
const confirm = z.boolean().optional().describe("True once the person has confirmed in the app.");
const section = sectionSchema.describe("Which list the item belongs to.");

const ALL_READ: readonly Scope[] = ["trip:read", "packing:read"];
const ALL_WRITE: readonly Scope[] = ["trip:write", "packing:write"];

const definitions: OperationDef[] = [
  defineOp({
    name: "get_trip",
    title: "Read the whole trip",
    description:
      "Returns the trip's details, itinerary, packing list, budget with calculated totals, bookings and notes. Needs trip:read.",
    audience: "all",
    mutating: false,
    destructive: false,
    anyOfScopes: ["trip:read"],
    input: z.strictObject({}),
    async run(ctx) {
      assertCanRead(ctx, "trip");
      return ctx.store.transaction((tx) => readSnapshot(tx, ctx));
    },
  }),

  defineOp({
    name: "get_itinerary",
    title: "Read the itinerary",
    description: "Returns the trip's dates and every itinerary item in day and time order. Needs trip:read.",
    audience: "all",
    mutating: false,
    destructive: false,
    anyOfScopes: ["trip:read"],
    input: z.strictObject({}),
    async run(ctx) {
      assertCanRead(ctx, "itinerary");
      return ctx.store.transaction(async (tx) => ({
        tripId: ctx.tripId,
        trip: toItem(await loadTrip(tx, ctx), ctx.principal),
        itinerary: await listSection(tx, ctx, "itinerary"),
      }));
    },
  }),

  defineOp({
    name: "get_packing_list",
    title: "Read the packing list",
    description: "Returns every packing item with its packed state and revision. Needs packing:read or trip:read.",
    audience: "all",
    mutating: false,
    destructive: false,
    anyOfScopes: ALL_READ,
    input: z.strictObject({}),
    async run(ctx) {
      assertCanRead(ctx, "packing");
      return ctx.store.transaction(async (tx) => {
        const items = await listSection(tx, ctx, "packing");
        return {
          tripId: ctx.tripId,
          items,
          totalCount: items.length,
          packedCount: items.filter((item) => item.data.packed === true).length,
        };
      });
    },
  }),

  defineOp({
    name: "set_packed",
    title: "Tick or untick a packing item",
    description:
      "Marks one packing item as packed or not packed. Setting the state it already has changes nothing. Needs packing:write or trip:write.",
    audience: "all",
    mutating: true,
    destructive: false,
    anyOfScopes: ALL_WRITE,
    input: z.strictObject({
      id: idSchema,
      packed: z.boolean(),
      expectedRevision: expectedRevision.optional(),
      idempotencyKey,
    }),
    async run(ctx, input) {
      assertCanWrite(ctx, "packing");
      return runMutation(ctx, "set_packed", input, async (tx) => {
        const entity = await loadLive(tx, ctx, "packing", input.id);
        if (input.expectedRevision !== undefined) assertRevision(entity, input.expectedRevision);
        if (entity.data.packed === input.packed) return unchanged(ctx, entity);
        return changed(
          ctx,
          await commitChange(tx, ctx, "set_packed", {
            before: entity,
            id: entity.id,
            kind: "packing",
            data: { ...entity.data, packed: input.packed },
            deletedAt: null,
            action: "update",
          }),
        );
      });
    },
  }),

  defineOp({
    name: "add_item",
    title: "Add an item",
    description:
      "Adds one item to a list. `data` holds the item's fields: itinerary {day, startTime?, title, location?, details?, status}; packing {label, category?, quantity, packed, assignee?}; budget {label, category, unitCents, quantity, status, paid}; bookings {type, name, status, startDate?, endDate?, location?, details?}; notes {title, body}. status is considering, selected or booked. Packing needs packing:write or trip:write; other lists need trip:write.",
    audience: "all",
    mutating: true,
    destructive: false,
    anyOfScopes: ALL_WRITE,
    input: z.strictObject({ section, data: dataObjectSchema, idempotencyKey }),
    async run(ctx, input) {
      assertCanWrite(ctx, input.section);
      refuseAgentConfirmationField(ctx, input.section, input.data);
      const data = validateData(input.section, input.data);
      return runMutation(ctx, "add_item", input, async (tx) => {
        const existing = await tx.listEntities(ctx.tripId, input.section);
        if (existing.length >= MAX_ITEMS_PER_SECTION) {
          throw new DomainError("limit_exceeded", `A list holds at most ${MAX_ITEMS_PER_SECTION} items.`);
        }
        return changed(
          ctx,
          await commitChange(tx, ctx, "add_item", {
            before: null,
            id: newId("itm"),
            kind: input.section,
            data,
            deletedAt: null,
            action: "create",
          }),
        );
      });
    },
  }),

  defineOp({
    name: "update_item",
    title: "Edit an item",
    description:
      "Changes the fields named in `patch` and leaves the rest as they are. Send an optional text field as an empty string to clear it. Packing needs packing:write or trip:write; other lists need trip:write.",
    audience: "all",
    mutating: true,
    destructive: false,
    anyOfScopes: ALL_WRITE,
    input: z.strictObject({
      section,
      id: idSchema,
      expectedRevision,
      patch: dataObjectSchema,
      idempotencyKey,
    }),
    async run(ctx, input) {
      assertCanWrite(ctx, input.section);
      return runMutation(ctx, "update_item", input, (tx) =>
        applyPatch(tx, ctx, "update_item", input.section, input.id, input.expectedRevision, input.patch),
      );
    },
  }),

  defineOp({
    name: "create_trip",
    title: "Set up the trip",
    description: "Creates this trip's own record: name, destination, dates, travelers. Only possible while none exists.",
    audience: "web",
    mutating: true,
    destructive: false,
    anyOfScopes: [],
    input: z.strictObject({ data: dataObjectSchema, idempotencyKey }),
    async run(ctx, input) {
      const data = validateData("trip", input.data);
      return runMutation(ctx, "create_trip", input, async (tx) => {
        if (await tx.getEntity(ctx.tripId, ctx.tripId)) {
          throw new DomainError("conflict", "This trip is already set up.");
        }
        return changed(
          ctx,
          await commitChange(tx, ctx, "create_trip", {
            before: null,
            id: ctx.tripId,
            kind: "trip",
            data,
            deletedAt: null,
            action: "create",
          }),
        );
      });
    },
  }),

  defineOp({
    name: "update_trip",
    title: "Edit the trip's details",
    description:
      "Changes the trip's title, destination, dates or number of travelers. Only the fields in `patch` change. Needs trip:write.",
    audience: "all",
    mutating: true,
    destructive: false,
    anyOfScopes: ["trip:write"],
    input: z.strictObject({ expectedRevision, patch: dataObjectSchema, idempotencyKey }),
    async run(ctx, input) {
      assertCanWrite(ctx, "trip");
      return runMutation(ctx, "update_trip", input, (tx) =>
        applyPatch(tx, ctx, "update_trip", "trip", ctx.tripId, input.expectedRevision, input.patch),
      );
    },
  }),

  defineOp({
    name: "remove_item",
    title: "Move an item to the trash",
    description:
      "Removes one item from its list. It goes to the trash and can be brought back with restore_item. Needs the person's confirmation.",
    audience: "web",
    mutating: true,
    destructive: true,
    anyOfScopes: [],
    input: z.strictObject({ section, id: idSchema, expectedRevision, confirm, idempotencyKey }),
    async run(ctx, input) {
      assertCanWrite(ctx, input.section);
      return runMutation(ctx, "remove_item", input, async (tx) => {
        const entity = await loadLive(tx, ctx, input.section, input.id);
        assertRevision(entity, input.expectedRevision);
        requirePersonConfirmation(ctx, input.confirm);
        return changed(
          ctx,
          await commitChange(tx, ctx, "remove_item", {
            before: entity,
            id: entity.id,
            kind: entity.kind,
            data: entity.data,
            deletedAt: iso(ctx.now),
            action: "remove",
          }),
        );
      });
    },
  }),

  defineOp({
    name: "restore_item",
    title: "Bring an item back from the trash",
    description:
      "Restores an item that a person moved to the trash. Packing needs packing:write or trip:write; other lists need trip:write.",
    audience: "all",
    mutating: true,
    destructive: false,
    anyOfScopes: ALL_WRITE,
    input: z.strictObject({ id: idSchema, idempotencyKey }),
    async run(ctx, input) {
      return runMutation(ctx, "restore_item", input, async (tx) => {
        const entity = await tx.getEntity(ctx.tripId, input.id);
        if (!entity || entity.kind === "trip" || !canRead(ctx.principal, entity.kind)) {
          throw new DomainError("not_found", "No such item.", { id: input.id });
        }
        assertCanWrite(ctx, entity.kind);
        if (entity.deletedAt === null) return unchanged(ctx, entity);
        const live = await tx.listEntities(ctx.tripId, entity.kind);
        if (live.length >= MAX_ITEMS_PER_SECTION) {
          throw new DomainError("limit_exceeded", `A list holds at most ${MAX_ITEMS_PER_SECTION} items.`);
        }
        return changed(
          ctx,
          await commitChange(tx, ctx, "restore_item", {
            before: entity,
            id: entity.id,
            kind: entity.kind,
            data: entity.data,
            deletedAt: null,
            action: "restore",
          }),
        );
      });
    },
  }),

  defineOp({
    name: "undo_change",
    title: "Undo one change",
    description:
      "Puts one item back to how it was before the change with this changeId (from a write's result or list_changes). Refused with a conflict if the item has been changed again since, so newer edits are never overwritten. Agents can undo edits and removals this way, but not additions or restores: taking an item out of the trip is for a person in the app. Needs write access to the item's list.",
    audience: "all",
    mutating: true,
    // Not destructive for agents: an agent's undo can never remove a record
    // (see commitChange) and can never override a newer edit (no force).
    destructive: false,
    anyOfScopes: ALL_WRITE,
    input: z.strictObject({
      changeId: idSchema,
      force: z.boolean().optional().describe("App only: undo even if the item changed again."),
      confirm,
      idempotencyKey,
    }),
    async run(ctx, input) {
      refuseAgentForce(ctx, input.force);
      return runMutation(ctx, "undo_change", input, async (tx) => {
        const change = await tx.getChange(ctx.tripId, input.changeId);
        if (!change || !canRead(ctx.principal, change.kind)) {
          throw new DomainError("not_found", "No such change.", { changeId: input.changeId });
        }
        assertCanWrite(ctx, change.kind);
        const live = await tx.getEntity(ctx.tripId, change.entityId);
        if (!live) throw new DomainError("not_found", "No such item.", { id: change.entityId });
        if (live.revision !== change.resultRevision) {
          if (!input.force) {
            throw new DomainError(
              "conflict",
              "This item was changed again after that change, so undoing it would overwrite newer edits.",
              { id: live.id, currentRevision: live.revision, changeRevision: change.resultRevision },
            );
          }
          if (input.confirm !== true) {
            throw new DomainError("confirmation_required", "Confirm this action to continue.");
          }
        }
        const wouldRemove = live.deletedAt === null && (change.before === null || change.before.deletedAt !== null);
        if (wouldRemove && ctx.principal.type !== "web") {
          throw new DomainError(
            "forbidden",
            "Undoing this would remove the item from the trip. Only a person in the app can do that.",
            { id: live.id },
          );
        }
        return changed(ctx, await commitUndo(tx, ctx, "undo_change", live, change.before));
      });
    },
  }),

  defineOp({
    name: "undo_batch",
    title: "Undo a whole batch of changes",
    description:
      "Undoes every change in one batch (the batchId on a write's result: all of one actor's changes on one day). Items created are trashed, edits are reverted, removed items are restored. Refused with a conflict if any of those items was changed by someone else since. Needs the person's confirmation.",
    audience: "web",
    mutating: true,
    destructive: true,
    anyOfScopes: [],
    input: z.strictObject({
      batchId: z.string().min(3).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      force: z.boolean().optional().describe("Undo even where items changed again."),
      confirm,
      idempotencyKey,
    }),
    async run(ctx, input) {
      return runMutation(ctx, "undo_batch", input, (tx) => undoBatch(tx, ctx, input));
    },
  }),

  defineOp({
    name: "list_changes",
    title: "List recent changes",
    description:
      "Returns the activity log, newest first: who did what to which item id, and whether it worked. It holds ids and outcomes only, never trip content. Filter by batchId to see one batch.",
    audience: "all",
    mutating: false,
    destructive: false,
    anyOfScopes: ALL_READ,
    input: z.strictObject({
      batchId: z.string().min(3).max(100).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async run(ctx, input) {
      // Without trip:read an agent only sees activity on the lists it can read.
      const kinds = canRead(ctx.principal, "trip")
        ? undefined
        : SECTIONS.filter((s) => canRead(ctx.principal, s));
      const records = await ctx.store.transaction((tx) =>
        tx.listAudit(ctx.tripId, {
          limit: input.limit ?? 50,
          ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
          ...(kinds ? { kinds } : {}),
        }),
      );
      const entries: ActivityEntry[] = records.map((record) => {
        const entry: ActivityEntry & { tripId?: string } = { ...record };
        delete entry.tripId;
        return entry;
      });
      return { tripId: ctx.tripId, entries };
    },
  }),

  defineOp({
    name: "list_trash",
    title: "List removed items",
    description: "Lists items in the trash.",
    audience: "web",
    mutating: false,
    destructive: false,
    anyOfScopes: [],
    input: z.strictObject({}),
    async run(ctx) {
      const entries = await ctx.store.transaction(async (tx) => {
        const out: TrashEntry[] = [];
        for (const kind of SECTIONS) {
          for (const entity of await tx.listEntities(ctx.tripId, kind, { includeDeleted: true })) {
            if (entity.deletedAt === null) continue;
            out.push({
              id: entity.id,
              section: kind,
              label: labelOf(entity),
              deletedAt: entity.deletedAt,
              revision: entity.revision,
            });
          }
        }
        return out.sort(bySortKey((entry) => entry.deletedAt)).reverse();
      });
      return { entries };
    },
  }),

  defineOp({
    name: "list_agents",
    title: "List connected agents",
    description: "Lists agents that hold access to this trip.",
    audience: "web",
    mutating: false,
    destructive: false,
    anyOfScopes: [],
    input: z.strictObject({}),
    async run(ctx) {
      const agents = await ctx.store.transaction((tx) => tx.listAgents(ctx.tripId));
      const summaries: AgentSummary[] = agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        scopes: agent.grants.find((grant) => grant.tripId === ctx.tripId)?.scopes ?? [],
        createdAt: agent.createdAt,
        revokedAt: agent.revokedAt,
      }));
      return { agents: summaries };
    },
  }),

  defineOp({
    name: "revoke_agent",
    title: "Revoke an agent",
    description: "Cuts off one agent's access immediately.",
    audience: "web",
    mutating: true,
    destructive: true,
    anyOfScopes: [],
    input: z.strictObject({ agentId: idSchema, confirm }),
    async run(ctx, input) {
      requirePersonConfirmation(ctx, input.confirm);
      return ctx.store.transaction(async (tx) => {
        const agent = await tx.getAgent(input.agentId);
        if (!agent || !agent.grants.some((grant) => grant.tripId === ctx.tripId)) {
          throw new DomainError("not_found", "No such agent.", { agentId: input.agentId });
        }
        if (agent.revokedAt === null) {
          await tx.putAgent({ ...agent, revokedAt: iso(ctx.now) });
          await appendAudit(tx, ctx, "revoke_agent", { outcome: "ok", entityId: agent.id });
        }
        return { status: "ok", agentId: agent.id };
      });
    },
  }),
];

async function applyPatch(
  tx: StoreTx,
  ctx: OpContext,
  op: string,
  kind: EntityKind,
  id: string,
  expected: number,
  patch: JsonObject,
): Promise<JsonObject> {
  const allowed: readonly string[] = DATA_KEYS[kind];
  const keys = Object.keys(patch);
  const unknownKeys = keys.filter((k) => !allowed.includes(k));
  if (keys.length === 0 || unknownKeys.length > 0) {
    throw new DomainError("validation_failed", "Some fields are not valid.", {
      issues:
        keys.length === 0
          ? [{ path: "patch", message: "Name at least one field to change." }]
          : unknownKeys.slice(0, 20).map((k) => ({ path: `patch.${k}`, message: "Unknown field." })),
    });
  }
  refuseAgentConfirmationField(ctx, kind, patch);

  const entity = await loadLive(tx, ctx, kind, id);
  assertRevision(entity, expected);
  const data = validateData(kind, { ...entity.data, ...patch });
  if (stableStringify(data) === stableStringify(entity.data)) return unchanged(ctx, entity);
  return changed(
    ctx,
    await commitChange(tx, ctx, op, {
      before: entity,
      id: entity.id,
      kind,
      data,
      deletedAt: null,
      action: "update",
    }),
  );
}

/** Returns a record to `target` (its state before a change), or trashes it if it did not exist. */
function commitUndo(
  tx: StoreTx,
  ctx: OpContext,
  op: string,
  live: StoredEntity,
  target: StoredEntity | null,
): Promise<Committed> {
  return commitChange(tx, ctx, op, {
    before: live,
    id: live.id,
    kind: live.kind,
    data: target ? target.data : live.data,
    deletedAt: target ? target.deletedAt : (live.deletedAt ?? iso(ctx.now)),
    action: "undo",
  });
}

async function undoBatch(
  tx: StoreTx,
  ctx: OpContext,
  input: { batchId: string; force?: boolean | undefined; confirm?: boolean | undefined },
): Promise<JsonObject> {
  const changes = (await tx.listChangesByBatch(ctx.tripId, input.batchId)).filter((change) =>
    canRead(ctx.principal, change.kind),
  );
  if (changes.length === 0) {
    throw new DomainError("not_found", "No changes in that batch.", { batchId: input.batchId });
  }

  const byEntity = new Map<string, typeof changes>();
  for (const change of changes) {
    const list = byEntity.get(change.entityId);
    if (list) list.push(change);
    else byEntity.set(change.entityId, [change]);
  }

  const plans: { live: StoredEntity; target: StoredEntity | null }[] = [];
  const conflicts: string[] = [];
  for (const [entityId, list] of byEntity) {
    assertCanWrite(ctx, list[0].kind);
    const live = await tx.getEntity(ctx.tripId, entityId);
    if (!live) continue;
    // Walk the batch's changes backwards. Each must start where the next one
    // ended; a gap means someone outside the batch edited the record.
    let revision = live.revision;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].resultRevision !== revision) {
        conflicts.push(entityId);
        break;
      }
      revision = list[i].before?.revision ?? 0;
    }
    plans.push({ live, target: list[0].before });
  }

  if (conflicts.length > 0 && !input.force) {
    throw new DomainError(
      "conflict",
      "Some items were changed by someone else after this batch. Nothing was undone.",
      { batchId: input.batchId, conflictingIds: conflicts },
    );
  }

  requirePersonConfirmation(ctx, input.confirm);

  const undone: JsonObject[] = [];
  for (const { live, target } of plans) {
    // Setting up the trip is not something a batch undo takes back.
    if (live.kind === "trip" && target === null) continue;
    const alreadyThere = target
      ? live.deletedAt === target.deletedAt &&
        stableStringify(live.data) === stableStringify(target.data)
      : live.deletedAt !== null;
    if (alreadyThere) continue;
    const committed = await commitUndo(tx, ctx, "undo_batch", live, target);
    undone.push({ id: live.id, kind: live.kind, changeId: committed.changeId });
  }
  return { status: "ok", undoneBatchId: input.batchId, undone, batchId: batchIdFor(ctx) };
}

export const OPERATIONS: ReadonlyMap<string, OperationDef> = new Map(
  definitions.map((def) => [def.name, def]),
);

/** Operations an agent may be shown, given the scopes it holds on this trip. */
export function operationsForAgent(scopes: readonly Scope[]): OperationDef[] {
  return definitions.filter(
    (def) => def.audience === "all" && def.anyOfScopes.some((scope) => scopes.includes(scope)),
  );
}

async function recordFailure(ctx: OpContext, op: string, outcome: string): Promise<void> {
  try {
    await ctx.store.transaction((tx) => appendAudit(tx, ctx, op, { outcome }));
  } catch {
    // The audit line is best effort here; the original failure is what the caller needs.
  }
}

export async function executeOperation(
  ctx: OpContext,
  name: string,
  rawInput: unknown,
): Promise<JsonObject> {
  const op = OPERATIONS.get(name);
  if (!op) throw new DomainError("unknown_operation", "No such operation.");

  try {
    if (ctx.principal.tripId !== ctx.tripId) {
      throw new DomainError("forbidden", "This credential does not belong to this trip.");
    }
    if (ctx.principal.type === "agent") {
      const scopes = ctx.principal.scopes;
      if (op.audience !== "all") {
        throw new DomainError("forbidden", "This action is only available in the app.");
      }
      if (!op.anyOfScopes.some((scope) => scopes.includes(scope))) {
        throw new DomainError("insufficient_scope", "This credential lacks the scope for that.");
      }
    }
    return await op.execute(ctx, rawInput);
  } catch (error) {
    if (error instanceof DomainError && (op.mutating || error.code === "insufficient_scope" || error.code === "forbidden")) {
      await recordFailure(ctx, name, error.code);
    }
    throw error;
  }
}
