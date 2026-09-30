// What each editor asks for. One description per record type keeps the five
// lists and the trip details on a single form component.

import { formatCents, parseDollarsToCents } from "@/domain/budget";
import {
  BOOKING_TYPES,
  BUDGET_CATEGORIES,
  STATUSES,
  type EntityKind,
  type Section,
  type Status,
  type TripData,
} from "@/domain/model";

export const STATUS_LABEL: Record<Status, string> = {
  considering: "Considering",
  selected: "Selected",
  booked: "Booked",
};

export const STATUS_HELP: Record<Status, string> = {
  considering: "An option, not decided",
  selected: "Chosen, not reserved yet",
  booked: "Reserved or bought",
};

export const SECTION_LABEL: Record<Section, string> = {
  itinerary: "Itinerary",
  packing: "Packing",
  budget: "Budget",
  bookings: "Bookings",
  notes: "Notes",
};

export const ITEM_NOUN: Record<EntityKind, string> = {
  itinerary: "plan",
  packing: "packing item",
  budget: "budget line",
  bookings: "booking",
  notes: "note",
  trip: "trip details",
};

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const options = (values: readonly string[], labels?: Record<string, string>) =>
  values.map((value) => ({ value, label: labels?.[value] ?? capitalize(value) }));

export type FieldType = "text" | "textarea" | "date" | "time" | "int" | "money" | "select" | "checkbox";

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  hint?: string;
  options?: { value: string; label: string }[];
}

const statusField: Field = {
  key: "status",
  label: "Status",
  type: "select",
  required: true,
  options: STATUSES.map((value) => ({ value, label: `${STATUS_LABEL[value]}: ${STATUS_HELP[value].toLowerCase()}` })),
};

export const FORM_FIELDS: Record<EntityKind, Field[]> = {
  trip: [
    { key: "title", label: "Trip name", type: "text", required: true, maxLength: 120 },
    { key: "destination", label: "Destination", type: "text", required: true, maxLength: 120 },
    { key: "startDate", label: "First day", type: "date", required: true },
    { key: "endDate", label: "Last day", type: "date", required: true },
    { key: "travelers", label: "Travelers", type: "int", required: true, min: 1, max: 20 },
    { key: "isSample", label: "This trip holds sample data", type: "checkbox" },
  ],
  itinerary: [
    { key: "title", label: "What", type: "text", required: true, maxLength: 120 },
    { key: "day", label: "Day", type: "date", required: true },
    { key: "startTime", label: "Time", type: "time", hint: "Leave empty for any time that day" },
    { key: "location", label: "Where", type: "text", maxLength: 160 },
    statusField,
    { key: "details", label: "Details", type: "textarea", maxLength: 2000 },
  ],
  packing: [
    { key: "label", label: "Item", type: "text", required: true, maxLength: 120 },
    { key: "quantity", label: "How many", type: "int", required: true, min: 1, max: 99 },
    { key: "category", label: "Group", type: "text", maxLength: 60, hint: "For example Documents or Beach" },
    { key: "assignee", label: "Who brings it", type: "text", maxLength: 40 },
    { key: "packed", label: "Packed", type: "checkbox" },
  ],
  budget: [
    { key: "label", label: "What", type: "text", required: true, maxLength: 120 },
    { key: "category", label: "Category", type: "select", required: true, options: options(BUDGET_CATEGORIES) },
    { key: "unitCents", label: "Price each (USD)", type: "money", required: true },
    { key: "quantity", label: "How many", type: "int", required: true, min: 1, max: 999, hint: "Nights, people, days" },
    statusField,
    { key: "paid", label: "Paid", type: "checkbox" },
  ],
  bookings: [
    { key: "name", label: "Name", type: "text", required: true, maxLength: 120 },
    { key: "type", label: "Type", type: "select", required: true, options: options(BOOKING_TYPES) },
    statusField,
    { key: "startDate", label: "From", type: "date" },
    { key: "endDate", label: "To", type: "date" },
    { key: "location", label: "Where", type: "text", maxLength: 160 },
    { key: "confirmation", label: "Reservation reference", type: "text", maxLength: 80, hint: "Agents never see this" },
    { key: "details", label: "Details", type: "textarea", maxLength: 2000 },
  ],
  notes: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 120 },
    { key: "body", label: "Note", type: "textarea", maxLength: 8000 },
  ],
};

export type FormValues = Record<string, string | boolean>;

/** Starting values for a new item. */
export function blankValues(kind: EntityKind, trip?: TripData): FormValues {
  const values: FormValues = {};
  for (const field of FORM_FIELDS[kind]) {
    if (field.type === "checkbox") values[field.key] = false;
    else if (field.type === "select") values[field.key] = field.key === "status" ? "considering" : (field.options?.[0]?.value ?? "");
    else if (field.type === "int") values[field.key] = "1";
    else values[field.key] = "";
  }
  if (kind === "itinerary" && trip) values.day = trip.startDate;
  return values;
}

export function toFormValues(kind: EntityKind, data: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const field of FORM_FIELDS[kind]) {
    const raw = data[field.key];
    if (field.type === "checkbox") values[field.key] = raw === true;
    else if (field.type === "money") values[field.key] = typeof raw === "number" ? formatCents(raw).replace(/[$,]/g, "") : "";
    else values[field.key] = raw === undefined || raw === null ? "" : String(raw);
  }
  return values;
}

/** Turns form text back into the record's fields, or explains the first problem. */
export function fromFormValues(
  kind: EntityKind,
  values: FormValues,
): { ok: true; data: Record<string, unknown> } | { ok: false; field: string; message: string } {
  const data: Record<string, unknown> = {};
  for (const field of FORM_FIELDS[kind]) {
    const raw = values[field.key];
    if (field.type === "checkbox") {
      data[field.key] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (field.required && text === "") {
      return { ok: false, field: field.key, message: `${field.label} is required.` };
    }
    if (field.type === "int") {
      const value = Number(text);
      if (!Number.isInteger(value) || value < (field.min ?? 0) || value > (field.max ?? Infinity)) {
        return { ok: false, field: field.key, message: `${field.label} must be a whole number from ${field.min} to ${field.max}.` };
      }
      data[field.key] = value;
    } else if (field.type === "money") {
      const cents = parseDollarsToCents(text);
      if (cents === null) {
        return { ok: false, field: field.key, message: `${field.label} must be an amount like 45 or 45.50.` };
      }
      data[field.key] = cents;
    } else {
      data[field.key] = field.type === "textarea" && typeof raw === "string" ? raw : text;
    }
  }
  if (kind === "trip") data.currency = "USD";
  return { ok: true, data };
}
