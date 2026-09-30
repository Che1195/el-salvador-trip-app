"use client";

import type { ReactNode } from "react";
import { formatCents, lineTotalCents } from "@/domain/budget";
import type {
  BookingData,
  BudgetData,
  Item,
  ItineraryData,
  NoteData,
  PackingData,
  Section,
  Status,
  TripSnapshot,
} from "@/domain/model";
import { SECTION_LABEL, STATUS_LABEL } from "./forms";
import { formatDateRange, formatDay, formatTime, tripDayNumber } from "./format";

// Booked, selected and considering look different in shape, not just color:
// solid, outlined, dashed. The same three marks are used on every screen.
const CHIP_STYLE: Record<Status, string> = {
  booked: "border-anil bg-anil text-white",
  selected: "border-anil bg-surface text-anil",
  considering: "border-dashed border-ash bg-transparent text-ash",
};
const STOP_STYLE: Record<Status, string> = {
  booked: "border-anil bg-anil",
  selected: "border-anil bg-surface",
  considering: "border-dashed border-ash bg-paper",
};

export function StatusChip({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border-2 px-2.5 py-0.5 text-xs font-semibold ${CHIP_STYLE[status]}`}
      data-testid={`status-${status}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SectionHeader({
  section,
  summary,
  onAdd,
}: {
  section: Section;
  summary?: string;
  onAdd(): void;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <h2 className="type-wide text-2xl">{SECTION_LABEL[section]}</h2>
        {summary && <p className="text-sm text-ash">{summary}</p>}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="rounded-md bg-anil px-4 py-2.5 text-sm font-semibold text-white"
        data-testid={`add-${section}`}
      >
        Add
      </button>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-ash">{children}</p>;
}

function RowButton({ onClick, testId, children }: { onClick(): void; testId: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="block w-full px-4 py-3 text-left" data-testid={testId}>
      {children}
    </button>
  );
}

const listClass = "divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface";

export function ItineraryView({
  snapshot,
  onEdit,
}: {
  snapshot: TripSnapshot;
  onEdit(item: Item<ItineraryData>): void;
}) {
  const { startDate, endDate } = snapshot.trip.data;
  const days = new Map<string, Item<ItineraryData>[]>();
  for (const item of snapshot.itinerary) {
    const list = days.get(item.data.day);
    if (list) list.push(item);
    else days.set(item.data.day, [item]);
  }
  if (days.size === 0) return <Empty>No plans yet. Add the first thing you want to do.</Empty>;

  return (
    <div className="space-y-7">
      {[...days].map(([day, items]) => {
        const number = tripDayNumber(day, startDate, endDate);
        return (
          <section key={day} aria-label={formatDay(day)}>
            <h3 className="mb-2 flex items-baseline gap-2">
              {number !== null && <span className="type-wide text-lg text-anil">Day {number}</span>}
              <span className="text-sm font-semibold text-ash">{formatDay(day)}</span>
            </h3>
            {/* The day's stops sit on one line, like a route card. */}
            <ol className="ml-2 border-l-2 border-anil">
              {items.map((item) => (
                <li key={item.id} className="relative">
                  <span
                    aria-hidden
                    className={`absolute -left-[9px] top-[1.15rem] size-4 rounded-full border-2 ${STOP_STYLE[item.data.status]}`}
                  />
                  <RowButton onClick={() => onEdit(item)} testId={`itinerary-${item.id}`}>
                    <span className="flex items-start justify-between gap-3 pl-3">
                      <span className="min-w-0">
                        <span className="nums block text-sm text-ash">
                          {item.data.startTime ? formatTime(item.data.startTime) : "Any time"}
                        </span>
                        <span className="block font-semibold">{item.data.title}</span>
                        {item.data.location && <span className="block text-sm text-ash">{item.data.location}</span>}
                        {item.data.details && <span className="mt-1 block whitespace-pre-wrap text-sm">{item.data.details}</span>}
                      </span>
                      <StatusChip status={item.data.status} />
                    </span>
                  </RowButton>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

export function PackingView({
  items,
  onToggle,
  onEdit,
}: {
  items: Item<PackingData>[];
  onToggle(item: Item<PackingData>, packed: boolean): void;
  onEdit(item: Item<PackingData>): void;
}) {
  if (items.length === 0) return <Empty>Nothing to pack yet. Add the first item.</Empty>;
  const groups = new Map<string, Item<PackingData>[]>();
  for (const item of items) {
    const group = item.data.category || "Everything else";
    const list = groups.get(group);
    if (list) list.push(item);
    else groups.set(group, [item]);
  }
  return (
    <div className="space-y-6">
      {[...groups].map(([group, list]) => (
        <section key={group}>
          <h3 className="mb-2 text-sm font-semibold text-ash">
            {group} <span className="nums font-normal">{list.filter((i) => i.data.packed).length}/{list.length}</span>
          </h3>
          <ul className={listClass}>
            {list.map((item) => (
              <li key={item.id} className="flex items-center gap-1">
                <label className="flex min-h-12 flex-1 cursor-pointer items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={item.data.packed}
                    onChange={(event) => onToggle(item, event.target.checked)}
                    className="size-6 shrink-0 accent-anil"
                    data-testid={`packed-${item.id}`}
                  />
                  <span className={item.data.packed ? "text-ash line-through" : ""}>
                    {item.data.label}
                    {item.data.quantity > 1 && <span className="nums text-ash"> ×{item.data.quantity}</span>}
                    {item.data.assignee && <span className="block text-sm text-ash no-underline">{item.data.assignee}</span>}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  className="mr-2 rounded-md px-3 py-2 text-sm font-semibold text-anil"
                  aria-label={`Edit ${item.data.label}`}
                  data-testid={`edit-packing-${item.id}`}
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TotalRow({ label, cents, note, strong }: { label: string; cents: number; note?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className={strong ? "font-semibold" : ""}>
        {label}
        {note && <span className="block text-xs text-ash">{note}</span>}
      </dt>
      <dd className={`nums ${strong ? "font-semibold" : ""}`}>{formatCents(cents)}</dd>
    </div>
  );
}

export function BudgetView({
  budget,
  onEdit,
}: {
  budget: TripSnapshot["budget"];
  onEdit(item: Item<BudgetData>): void;
}) {
  const { totals, lines } = budget;
  return (
    <div className="space-y-6">
      <section className="rounded-lg bg-anil px-4 py-4 text-white" aria-label="Totals" data-testid="budget-totals">
        <p className="text-sm opacity-85">Planned spend, selected plus booked</p>
        <p className="type-wide nums text-4xl" data-testid="budget-committed">
          {formatCents(totals.committedCents)}
        </p>
        <p className="nums mt-1 text-sm opacity-85">
          {formatCents(totals.perTravelerCents)} each for {totals.travelers}
          {totals.perTravelerRemainderCents > 0 && `, ${formatCents(totals.perTravelerRemainderCents)} left over`}
        </p>
      </section>

      <dl className="rounded-lg border border-line bg-surface px-4 py-2">
        <TotalRow label="Booked" cents={totals.byStatus.booked} strong />
        <TotalRow label="Selected" cents={totals.byStatus.selected} note="Chosen, not reserved yet" strong />
        <TotalRow label="Considering" cents={totals.byStatus.considering} note="Not counted in planned spend" />
        <div className="my-1 border-t border-line" />
        <TotalRow label="Paid so far" cents={totals.paidCents} />
        <TotalRow label="Still to pay" cents={totals.unpaidCommittedCents} />
      </dl>

      {lines.length === 0 ? (
        <Empty>No costs yet. Add the first line.</Empty>
      ) : (
        <ul className={listClass}>
          {lines.map((line) => (
            <li key={line.id}>
              <RowButton onClick={() => onEdit(line)} testId={`budget-${line.id}`}>
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-semibold">{line.data.label}</span>
                    <span className="nums block text-sm text-ash">
                      {line.data.quantity} × {formatCents(line.data.unitCents)}, {line.data.category}
                      {line.data.paid && ", paid"}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="nums font-semibold">{formatCents(lineTotalCents(line.data))}</span>
                    <StatusChip status={line.data.status} />
                  </span>
                </span>
              </RowButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BookingsView({
  items,
  onEdit,
}: {
  items: Item<BookingData>[];
  onEdit(item: Item<BookingData>): void;
}) {
  if (items.length === 0) return <Empty>No bookings yet. Add lodging, transport or an activity.</Empty>;
  return (
    <ul className={listClass}>
      {items.map((item) => {
        const dates = formatDateRange(item.data.startDate, item.data.endDate);
        return (
          <li key={item.id}>
            <RowButton onClick={() => onEdit(item)} testId={`booking-${item.id}`}>
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-semibold">{item.data.name}</span>
                  <span className="block text-sm text-ash">
                    {[item.data.type, dates, item.data.location].filter(Boolean).join(", ")}
                  </span>
                  {item.data.confirmation && (
                    <span className="nums block text-sm">Reference {item.data.confirmation}</span>
                  )}
                  {item.data.details && <span className="mt-1 block whitespace-pre-wrap text-sm">{item.data.details}</span>}
                </span>
                <StatusChip status={item.data.status} />
              </span>
            </RowButton>
          </li>
        );
      })}
    </ul>
  );
}

export function NotesView({ items, onEdit }: { items: Item<NoteData>[]; onEdit(item: Item<NoteData>): void }) {
  if (items.length === 0) return <Empty>No notes yet. Add anything worth remembering.</Empty>;
  return (
    <ul className={listClass}>
      {items.map((item) => (
        <li key={item.id}>
          <RowButton onClick={() => onEdit(item)} testId={`note-${item.id}`}>
            <span className="block font-semibold">{item.data.title}</span>
            {item.data.body && <span className="mt-1 block whitespace-pre-wrap text-sm">{item.data.body}</span>}
          </RowButton>
        </li>
      ))}
    </ul>
  );
}
