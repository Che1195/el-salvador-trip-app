import "server-only";
import { z } from "zod";
import {
  BOOKING_TYPES,
  BUDGET_CATEGORIES,
  SECTIONS,
  STATUSES,
  type BookingData,
  type BudgetData,
  type EntityKind,
  type ItineraryData,
  type NoteData,
  type PackingData,
  type TripData,
} from "@/domain/model";

// Plain text only. Control characters are refused so stored values can be
// rendered, logged as lengths, and handed to agents without surprises.
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;
const MULTI_LINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

const requiredLine = (max: number) =>
  z.string().trim().min(1).max(max).regex(SINGLE_LINE, "Control characters are not allowed");
/** Optional text: omit it, or send "" to clear it. */
const optionalLine = (max: number) =>
  z.string().trim().max(max).regex(SINGLE_LINE, "Control characters are not allowed").optional();
const optionalBlock = (max: number) =>
  z.string().max(max).regex(MULTI_LINE, "Control characters are not allowed").optional();

const isoDate = z.iso.date();
const optionalDate = z.union([z.literal(""), isoDate]).optional();
const optionalTime = z
  .union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM")])
  .optional();
const status = z.enum(STATUSES);

export const tripSchema = z
  .strictObject({
    title: requiredLine(120),
    destination: requiredLine(120),
    startDate: isoDate,
    endDate: isoDate,
    travelers: z.number().int().min(1).max(20),
    currency: z.literal("USD"),
    isSample: z.boolean(),
  })
  .refine((t) => t.endDate >= t.startDate, {
    path: ["endDate"],
    message: "End date must not be before start date",
  }) satisfies z.ZodType<TripData>;

export const itinerarySchema = z.strictObject({
  day: isoDate,
  startTime: optionalTime,
  title: requiredLine(120),
  location: optionalLine(160),
  details: optionalBlock(2000),
  status,
}) satisfies z.ZodType<ItineraryData>;

export const packingSchema = z.strictObject({
  label: requiredLine(120),
  category: optionalLine(60),
  quantity: z.number().int().min(1).max(99),
  packed: z.boolean(),
  assignee: optionalLine(40),
}) satisfies z.ZodType<PackingData>;

export const budgetSchema = z.strictObject({
  label: requiredLine(120),
  category: z.enum(BUDGET_CATEGORIES),
  // Up to $1,000,000.00 per unit keeps every total far inside safe integers.
  unitCents: z.number().int().min(0).max(100_000_000),
  quantity: z.number().int().min(1).max(999),
  status,
  paid: z.boolean(),
}) satisfies z.ZodType<BudgetData>;

export const bookingSchema = z
  .strictObject({
    type: z.enum(BOOKING_TYPES),
    name: requiredLine(120),
    status,
    startDate: optionalDate,
    endDate: optionalDate,
    location: optionalLine(160),
    details: optionalBlock(2000),
    confirmation: optionalLine(80),
  })
  .refine((b) => !b.startDate || !b.endDate || b.endDate >= b.startDate, {
    path: ["endDate"],
    message: "End date must not be before start date",
  }) satisfies z.ZodType<BookingData>;

export const noteSchema = z.strictObject({
  title: requiredLine(120),
  body: z.string().max(8000).regex(MULTI_LINE, "Control characters are not allowed"),
}) satisfies z.ZodType<NoteData>;

export const DATA_SCHEMAS = {
  trip: tripSchema,
  itinerary: itinerarySchema,
  packing: packingSchema,
  budget: budgetSchema,
  bookings: bookingSchema,
  notes: noteSchema,
} as const satisfies Record<EntityKind, z.ZodType>;

/** Fields each kind accepts. A patch may only name these. */
export const DATA_KEYS = {
  trip: ["title", "destination", "startDate", "endDate", "travelers", "currency", "isSample"],
  itinerary: ["day", "startTime", "title", "location", "details", "status"],
  packing: ["label", "category", "quantity", "packed", "assignee"],
  budget: ["label", "category", "unitCents", "quantity", "status", "paid"],
  bookings: [
    "type",
    "name",
    "status",
    "startDate",
    "endDate",
    "location",
    "details",
    "confirmation",
  ],
  notes: ["title", "body"],
} as const satisfies { [K in EntityKind]: readonly string[] };

export const sectionSchema = z.enum(SECTIONS);

/** Caller-chosen key that makes a retried write apply once. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, digits, and _ . : -");

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const revisionSchema = z.number().int().min(1);
export const dataObjectSchema = z.record(z.string(), z.unknown());

export interface FieldIssue {
  path: string;
  message: string;
}

/** Field paths and messages only. The rejected values are never echoed. */
export function issuesOf(error: z.ZodError): FieldIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
