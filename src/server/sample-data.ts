// FICTITIOUS SAMPLE CONTENT. Every place, price, date and reference below is
// made up for local development and tests. No real trip detail belongs in
// this file or anywhere else in the repository: real trip content is entered
// in the running app and lives only in private server storage.

import "server-only";
import type {
  BookingData,
  BudgetData,
  ItineraryData,
  NoteData,
  PackingData,
  Section,
  TripData,
} from "@/domain/model";
import { newId } from "./hash";
import { DATA_SCHEMAS } from "./schemas";
import type { JsonObject, Store, StoredEntity } from "./store/types";

export const SAMPLE_AUTHOR = "Sample data";

function addDays(from: Date, days: number): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}

/** Builds the sample trip relative to `now`, so it never carries a fixed date. */
export function buildSampleTrip(now: Date) {
  const day = (offset: number) => addDays(now, 30 + offset);

  const trip: TripData = {
    title: "Sample trip",
    destination: "Costa Ejemplo (not a real place)",
    startDate: day(0),
    endDate: day(4),
    travelers: 2,
    currency: "USD",
    isSample: true,
  };

  const itinerary: ItineraryData[] = [
    { day: day(0), startTime: "14:10", title: "Land at Example Airport", location: "Terminal Muestra", status: "booked" },
    { day: day(0), startTime: "17:00", title: "Check in at Casa Muestra", location: "Playa Ejemplo", status: "booked" },
    { day: day(1), startTime: "08:30", title: "Surf lesson", location: "Playa Ejemplo", details: "Two hours. Boards included.", status: "selected" },
    { day: day(1), startTime: "19:00", title: "Dinner at Comedor Inventado", status: "considering" },
    { day: day(2), startTime: "06:00", title: "Volcano hike", location: "Cerro Ficticio", details: "Bring layers, it is cold at the top.", status: "selected" },
    { day: day(3), title: "Free day in the old town", location: "Villa Simulada", status: "considering" },
    { day: day(4), startTime: "11:45", title: "Fly home", location: "Example Airport", status: "booked" },
  ];

  const packing: PackingData[] = [
    { label: "Passports", category: "Documents", quantity: 2, packed: true },
    { label: "Travel insurance printout", category: "Documents", quantity: 1, packed: false },
    { label: "Reef-safe sunscreen", category: "Beach", quantity: 2, packed: false },
    { label: "Swimsuits", category: "Beach", quantity: 2, packed: true },
    { label: "Hiking shoes", category: "Hike", quantity: 2, packed: false },
    { label: "Rain jacket", category: "Hike", quantity: 2, packed: false },
    { label: "Phone chargers", category: "Tech", quantity: 2, packed: false },
  ];

  const budget: BudgetData[] = [
    { label: "Flights", category: "transport", unitCents: 41250, quantity: 2, status: "booked", paid: true },
    { label: "Casa Muestra, per night", category: "lodging", unitCents: 9800, quantity: 4, status: "booked", paid: false },
    { label: "Surf lesson", category: "activities", unitCents: 4500, quantity: 2, status: "selected", paid: false },
    { label: "Volcano guide", category: "activities", unitCents: 3000, quantity: 2, status: "selected", paid: false },
    { label: "Rental car, per day", category: "transport", unitCents: 5575, quantity: 3, status: "considering", paid: false },
    { label: "Food, per day", category: "food", unitCents: 6000, quantity: 5, status: "selected", paid: false },
  ];

  const bookings: BookingData[] = [
    { type: "transport", name: "Example Air, round trip", status: "booked", startDate: day(0), endDate: day(4), confirmation: "SAMPLE-0000" },
    { type: "lodging", name: "Casa Muestra", status: "booked", startDate: day(0), endDate: day(4), location: "Playa Ejemplo", details: "Made-up beach house. Check-in after 15:00.", confirmation: "SAMPLE-1111" },
    { type: "activity", name: "Surf lesson with Escuela Inventada", status: "selected", startDate: day(1), location: "Playa Ejemplo" },
    { type: "lodging", name: "Hostal Ficticio", status: "considering", startDate: day(2), endDate: day(3), location: "Villa Simulada", details: "Backup if we stay inland a night." },
  ];

  const notes: NoteData[] = [
    { title: "About this sample", body: "Everything here is fictitious sample data. Edit anything to try the app. Real trip details go in only after private storage is set up." },
    { title: "Questions to settle", body: "Rent a car or use shuttles?\nWhich day for the hike?" },
  ];

  return { trip, itinerary, packing, budget, bookings, notes };
}

/** Puts the sample trip into an empty store. Does nothing if the trip already exists. */
export async function seedSampleTrip(store: Store, tripId: string, now: Date): Promise<void> {
  if (store.scope === "production") {
    throw new Error("Sample data must never be written to production storage.");
  }
  const sample = buildSampleTrip(now);
  const at = now.toISOString();
  const record = (id: string, kind: StoredEntity["kind"], data: unknown): StoredEntity => ({
    tripId,
    id,
    kind,
    revision: 1,
    data: DATA_SCHEMAS[kind].parse(data) as JsonObject,
    createdAt: at,
    updatedAt: at,
    updatedBy: SAMPLE_AUTHOR,
    deletedAt: null,
  });

  await store.transaction(async (tx) => {
    if (await tx.getEntity(tripId, tripId)) return;
    await tx.putEntity(record(tripId, "trip", sample.trip));
    const sections: [Section, readonly unknown[]][] = [
      ["itinerary", sample.itinerary],
      ["packing", sample.packing],
      ["budget", sample.budget],
      ["bookings", sample.bookings],
      ["notes", sample.notes],
    ];
    let order = 0;
    for (const [section, rows] of sections) {
      for (const row of rows) {
        const entity = record(newId("itm"), section, row);
        // Distinct creation times keep the sample in its written order.
        entity.createdAt = new Date(now.getTime() + order++).toISOString();
        await tx.putEntity(entity);
      }
    }
  });
}
