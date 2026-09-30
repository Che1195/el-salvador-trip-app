"use client";

import { useCallback, useEffect, useState } from "react";
import { SECTIONS, type EntityKind, type Item, type PackingData, type Section, type TripSnapshot } from "@/domain/model";
import { ApiError, callOp, fetchTrip, leaveToSignIn, newIdempotencyKey } from "./api";
import { Editor } from "./Editor";
import { blankValues, SECTION_LABEL, toFormValues } from "./forms";
import { formatDateRange } from "./format";
import { MorePanel } from "./MorePanel";
import { BookingsView, BudgetView, ItineraryView, NotesView, PackingView, SectionHeader } from "./sections";

type Tab = Section | "more";
const TABS: readonly Tab[] = [...SECTIONS, "more"];
const REFRESH_MS = 20_000;

interface Editing {
  kind: EntityKind;
  item: Item<Record<string, unknown>> | null;
  /** One key per editor session, so a double tap on Save adds one item. */
  idempotencyKey: string;
}

const TAB_ICON: Record<Tab, string> = {
  itinerary: "M6 5v14M6 5a2 2 0 1 0 0-.01M6 19a2 2 0 1 0 0-.01M11 6h8M11 12h8M11 18h8",
  packing: "M4 5h16v14H4zM8 12l3 3 5-6",
  budget: "M12 3v18M16.5 7.5c-.8-1.2-2.4-2-4.5-2-2.5 0-4.5 1.2-4.5 3.2 0 4.3 9 2.3 9 6.6 0 2-2 3.2-4.5 3.2-2.1 0-3.7-.8-4.5-2",
  bookings: "M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 15h18M7 9V7a1 1 0 0 1 1-1h3v3",
  notes: "M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "conflict") return "Someone changed this while you were working. The latest version is showing now; make your change again.";
    if (error.code === "rate_limited") return "Too many changes at once. Wait a minute and try again.";
    if (error.code === "validation_failed") {
      const issues = error.details?.issues;
      if (Array.isArray(issues) && issues.length > 0) {
        const first = issues[0] as { path?: string; message?: string };
        return `${first.path ? `${first.path}: ` : ""}${first.message ?? "That value is not valid."}`;
      }
    }
    return error.message;
  }
  return "Something went wrong. Try again.";
}

export function Workspace({
  initial,
  signedInAs,
  fixturePasswordInUse,
}: {
  initial: TripSnapshot;
  signedInAs: string;
  fixturePasswordInUse: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [tab, setTab] = useState<Tab>("itinerary");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const report = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      leaveToSignIn();
      return;
    }
    setNotice(explain(error));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchTrip());
    } catch (error) {
      report(error);
    }
  }, [report]);

  // Pick up changes made on another device or by an agent.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const open = (kind: EntityKind, item: Item<object> | null) =>
    setEditing({ kind, item: item as Item<Record<string, unknown>> | null, idempotencyKey: newIdempotencyKey() });

  async function save(data: Record<string, unknown>): Promise<string | null> {
    if (!editing) return null;
    const { kind, item, idempotencyKey } = editing;
    try {
      if (kind === "trip") {
        await callOp("update_trip", { expectedRevision: item?.revision, patch: data, idempotencyKey });
      } else if (item) {
        await callOp("update_item", { section: kind, id: item.id, expectedRevision: item.revision, patch: data, idempotencyKey });
      } else {
        await callOp("add_item", { section: kind, data, idempotencyKey });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) report(error);
      if (error instanceof ApiError && error.code === "conflict") {
        await refresh();
        return "Someone changed this while you were editing. Cancel and open it again to see the latest version.";
      }
      return explain(error);
    }
    setEditing(null);
    setNotice(null);
    await refresh();
    return null;
  }

  async function remove(): Promise<string | null> {
    if (!editing?.item || editing.kind === "trip") return null;
    try {
      await callOp("remove_item", {
        section: editing.kind,
        id: editing.item.id,
        expectedRevision: editing.item.revision,
        confirm: true,
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") await refresh();
      return explain(error);
    }
    setEditing(null);
    setNotice("Moved to the trash. Restore it from More.");
    await refresh();
    return null;
  }

  async function togglePacked(item: Item<PackingData>, packed: boolean) {
    // Show the tick at once, then let the server's answer settle it.
    setSnapshot((current) => ({
      ...current,
      packing: current.packing.map((p) => (p.id === item.id ? { ...p, data: { ...p.data, packed } } : p)),
    }));
    try {
      await callOp("set_packed", { id: item.id, packed, idempotencyKey: newIdempotencyKey() });
    } catch (error) {
      report(error);
    }
    await refresh();
  }

  const { trip } = snapshot;
  const packedCount = snapshot.packing.filter((p) => p.data.packed).length;

  return (
    <div className="flex h-dvh flex-col">
      <header className="bg-anil px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white">
        <div className="mx-auto max-w-2xl">
          <h1 className="type-wide text-3xl leading-tight" data-testid="trip-title">
            {trip.data.title}
          </h1>
          <p className="mt-1 text-sm opacity-85">
            {trip.data.destination}, {formatDateRange(trip.data.startDate, trip.data.endDate)}
          </p>
        </div>
      </header>

      {trip.data.isSample && (
        <p className="bg-maiz px-4 py-1.5 text-center text-sm font-semibold text-ink" data-testid="sample-banner">
          Sample data. Nothing here is a real plan.
        </p>
      )}

      <main className="flex-1 overflow-y-auto overflow-x-clip px-4 py-5">
        <div className="mx-auto max-w-2xl">
          {notice && (
            <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-md border border-anil bg-anil-wash px-3 py-2 text-sm" data-testid="notice">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="shrink-0 font-semibold text-anil underline">
                Dismiss
              </button>
            </div>
          )}

          {tab === "itinerary" && (
            <>
              <SectionHeader section="itinerary" summary={`${snapshot.itinerary.length} plans`} onAdd={() => open("itinerary", null)} />
              <ItineraryView snapshot={snapshot} onEdit={(item) => open("itinerary", item)} />
            </>
          )}
          {tab === "packing" && (
            <>
              <SectionHeader section="packing" summary={`${packedCount} of ${snapshot.packing.length} packed`} onAdd={() => open("packing", null)} />
              <PackingView items={snapshot.packing} onToggle={togglePacked} onEdit={(item) => open("packing", item)} />
            </>
          )}
          {tab === "budget" && (
            <>
              <SectionHeader section="budget" summary={`${snapshot.budget.lines.length} lines`} onAdd={() => open("budget", null)} />
              <BudgetView budget={snapshot.budget} onEdit={(item) => open("budget", item)} />
            </>
          )}
          {tab === "bookings" && (
            <>
              <SectionHeader
                section="bookings"
                summary={`${snapshot.bookings.filter((b) => b.data.status === "booked").length} booked, ${snapshot.bookings.filter((b) => b.data.status === "selected").length} selected`}
                onAdd={() => open("bookings", null)}
              />
              <BookingsView items={snapshot.bookings} onEdit={(item) => open("bookings", item)} />
            </>
          )}
          {tab === "notes" && (
            <>
              <SectionHeader section="notes" onAdd={() => open("notes", null)} />
              <NotesView items={snapshot.notes} onEdit={(item) => open("notes", item)} />
            </>
          )}
          {tab === "more" && (
            <MorePanel
              snapshot={snapshot}
              signedInAs={signedInAs}
              fixturePasswordInUse={fixturePasswordInUse}
              onEditTrip={() => open("trip", trip)}
              onChanged={refresh}
              onProblem={report}
            />
          )}
        </div>
      </main>

      {/* A normal flex child, not position: fixed, so the phone keyboard cannot strand it. */}
      <nav aria-label="Sections" className="border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-2xl">
          {TABS.map((name) => {
            const active = tab === name;
            return (
              <li key={name} className="flex-1">
                <button
                  type="button"
                  onClick={() => setTab(name)}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full flex-col items-center gap-0.5 px-1 py-2 text-[0.6875rem] ${active ? "font-semibold text-anil" : "text-ash"}`}
                  data-testid={`tab-${name}`}
                >
                  <svg viewBox="0 0 24 24" aria-hidden className="size-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
                    <path d={TAB_ICON[name]} />
                  </svg>
                  {name === "more" ? "More" : SECTION_LABEL[name]}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {editing && (
        <Editor
          key={editing.idempotencyKey}
          kind={editing.kind}
          itemId={editing.item?.id ?? null}
          initial={editing.item ? toFormValues(editing.kind, editing.item.data) : blankValues(editing.kind, trip.data)}
          onSave={save}
          {...(editing.item && editing.kind !== "trip" ? { onRemove: remove } : {})}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
