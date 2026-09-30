// Shared trip model: constants and plain types only. No server imports and
// no validation library, so the browser bundle can use it freely.

export const SECTIONS = ["itinerary", "packing", "budget", "bookings", "notes"] as const;
export type Section = (typeof SECTIONS)[number];

/**
 * Every stored record belongs to exactly one trip and is either a section item
 * or that trip's own record (kind "trip", whose id is the trip id). The trip
 * record holds the editable configuration: title, destination, dates.
 */
export type EntityKind = Section | "trip";

/**
 * considering: an option on the table.
 * selected: chosen, but no reservation exists yet.
 * booked: a reservation or purchase has been made.
 */
export const STATUSES = ["considering", "selected", "booked"] as const;
export type Status = (typeof STATUSES)[number];

export const BUDGET_CATEGORIES = ["lodging", "transport", "food", "activities", "other"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export const BOOKING_TYPES = ["lodging", "transport", "activity", "other"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

export interface TripData {
  title: string;
  destination: string;
  /** ISO date, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  travelers: number;
  currency: "USD";
  /** True while the record holds fictitious sample content. */
  isSample: boolean;
}

export interface ItineraryData {
  day: string;
  /** HH:MM, or empty when the item has no set time. */
  startTime?: string;
  title: string;
  location?: string;
  details?: string;
  status: Status;
}

export interface PackingData {
  label: string;
  category?: string;
  quantity: number;
  packed: boolean;
  assignee?: string;
}

export interface BudgetData {
  label: string;
  category: BudgetCategory;
  /** Price of one unit in minor units (cents). Integer. */
  unitCents: number;
  quantity: number;
  status: Status;
  paid: boolean;
}

export interface BookingData {
  type: BookingType;
  name: string;
  status: Status;
  startDate?: string;
  endDate?: string;
  location?: string;
  details?: string;
  /** Reservation reference. Never sent to agents. */
  confirmation?: string;
}

export interface NoteData {
  title: string;
  body: string;
}

export interface SectionDataMap {
  itinerary: ItineraryData;
  packing: PackingData;
  budget: BudgetData;
  bookings: BookingData;
  notes: NoteData;
}

export interface Item<T> {
  id: string;
  /** Increases by one on every saved change. Send it back to edit safely. */
  revision: number;
  updatedAt: string;
  updatedBy: string;
  data: T;
}

export interface BudgetTotals {
  currency: "USD";
  byStatus: Record<Status, number>;
  byCategory: Record<BudgetCategory, number>;
  /** selected + booked. */
  committedCents: number;
  paidCents: number;
  /** Committed and not yet paid. */
  unpaidCommittedCents: number;
  travelers: number;
  /** Committed total split evenly, rounded down to the cent. */
  perTravelerCents: number;
  /** Cents left over after the even split. */
  perTravelerRemainderCents: number;
}

export type StorageKind = "memory-fixture" | "postgres";

export interface TripSnapshot {
  tripId: string;
  trip: Item<TripData>;
  itinerary: Item<ItineraryData>[];
  packing: Item<PackingData>[];
  budget: { lines: Item<BudgetData>[]; totals: BudgetTotals };
  bookings: Item<BookingData>[];
  notes: Item<NoteData>[];
  storage: { kind: StorageKind; durable: boolean };
}

export const SCOPES = ["trip:read", "packing:read", "packing:write", "trip:write"] as const;
export type Scope = (typeof SCOPES)[number];

export type ChangeAction = "create" | "update" | "remove" | "restore" | "undo";

/** One line of the activity log. Holds ids and outcomes, never trip content. */
export interface ActivityEntry {
  id: string;
  at: string;
  actorType: "web" | "agent" | "system";
  actorId: string;
  actorLabel: string;
  op: string;
  kind: EntityKind | null;
  entityId: string | null;
  batchId: string | null;
  changeId: string | null;
  outcome: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  /** Scopes this agent holds on the current trip. */
  scopes: Scope[];
  createdAt: string;
  revokedAt: string | null;
}

export interface TrashEntry {
  id: string;
  section: Section;
  label: string;
  deletedAt: string;
  revision: number;
}
