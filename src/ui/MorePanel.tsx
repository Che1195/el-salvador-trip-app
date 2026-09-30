"use client";

import { useEffect, useState } from "react";
import type { ActivityEntry, AgentSummary, TrashEntry, TripSnapshot } from "@/domain/model";
import { ApiError, callOp, fetchActivity, leaveToSignIn, newIdempotencyKey, signOut } from "./api";
import { ITEM_NOUN, SECTION_LABEL } from "./forms";
import { formatDateRange, formatStamp } from "./format";

const OP_PHRASE: Record<string, string> = {
  add_item: "added a",
  update_item: "edited a",
  set_packed: "ticked or unticked a",
  remove_item: "removed a",
  restore_item: "restored a",
  undo_change: "undid a change to a",
  undo_batch: "undid changes to a",
  update_trip: "edited the",
  revoke_agent: "revoked an agent",
  sign_in: "signed in",
  sign_out: "signed out",
  sign_out_everywhere: "signed out every device",
};

const OUTCOME_NOTE: Record<string, string> = {
  conflict: "Refused: the item had changed",
  insufficient_scope: "Refused: not allowed for this agent",
  forbidden: "Refused: not allowed",
  validation_failed: "Refused: not valid",
  confirmation_required: "Stopped: needed confirmation",
  invalid_credentials: "Wrong password",
  not_found: "Refused: item not found",
  limit_exceeded: "Refused: list is full",
  idempotency_key_reused: "Refused: repeated request id",
};

function describe(entry: ActivityEntry): string {
  const phrase = OP_PHRASE[entry.op] ?? entry.op;
  const noun = entry.kind ? ` ${ITEM_NOUN[entry.kind]}` : "";
  return `${entry.actorLabel} ${phrase}${phrase.endsWith(" a") || phrase.endsWith(" the") ? noun : ""}`;
}

const panelClass = "rounded-lg border border-line bg-surface";
const quietButton = "rounded-md border border-line px-3 py-2 text-sm font-semibold text-anil";

export function MorePanel({
  snapshot,
  signedInAs,
  fixturePasswordInUse,
  onEditTrip,
  onChanged,
  onProblem,
}: {
  snapshot: TripSnapshot;
  signedInAs: string;
  fixturePasswordInUse: boolean;
  onEditTrip(): void;
  onChanged(): Promise<void>;
  onProblem(error: unknown): void;
}) {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  // Reload whenever the trip changes, so this panel matches what was just saved.
  useEffect(() => {
    let current = true;
    Promise.all([
      fetchActivity(),
      callOp<{ entries: TrashEntry[] }>("list_trash", {}),
      callOp<{ agents: AgentSummary[] }>("list_agents", {}),
    ]).then(
      ([entries, trashResult, agentResult]) => {
        if (!current) return;
        setActivity(entries);
        setTrash(trashResult.entries);
        setAgents(agentResult.agents);
      },
      (error: unknown) => {
        if (current) onProblem(error);
      },
    );
    return () => {
      current = false;
    };
  }, [snapshot, onProblem]);

  async function act(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      onProblem(error);
    }
    await onChanged();
  }

  async function undo(entry: ActivityEntry) {
    try {
      await callOp("undo_change", { changeId: entry.changeId, idempotencyKey: newIdempotencyKey() });
    } catch (error) {
      const changedSince = error instanceof ApiError && error.code === "conflict";
      if (!changedSince) return onProblem(error);
      const force = window.confirm(
        "This item was changed again after that. Undo anyway? The newer edits to it will be replaced.",
      );
      if (!force) return;
      await act(() => callOp("undo_change", { changeId: entry.changeId, force: true, confirm: true, idempotencyKey: newIdempotencyKey() }));
      return;
    }
    await onChanged();
  }

  const { trip, storage } = snapshot;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="type-wide mb-3 text-2xl">Trip details</h2>
        <div className={`${panelClass} flex items-start justify-between gap-3 px-4 py-3`}>
          <p>
            <span className="block font-semibold">{trip.data.title}</span>
            <span className="block text-sm text-ash">
              {trip.data.destination}, {formatDateRange(trip.data.startDate, trip.data.endDate)}, {trip.data.travelers}{" "}
              {trip.data.travelers === 1 ? "traveler" : "travelers"}
            </span>
          </p>
          <button type="button" onClick={onEditTrip} className={quietButton} data-testid="edit-trip">
            Edit
          </button>
        </div>
      </section>

      <section>
        <h2 className="type-wide mb-1 text-2xl">Activity</h2>
        <p className="mb-3 text-sm text-ash">Every change by you, the other traveler, or an agent. Undo puts one item back.</p>
        {activity === null ? (
          <p className="text-ash">Loading activity</p>
        ) : activity.length === 0 ? (
          <p className="text-ash">No changes yet.</p>
        ) : (
          <ul className={`${panelClass} divide-y divide-line`} data-testid="activity">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <p className="min-w-0 text-sm">
                  <span className="block">
                    {entry.actorType === "agent" && (
                      <span className="mr-1.5 rounded bg-anil-wash px-1.5 py-0.5 text-xs font-semibold text-anil">Agent</span>
                    )}
                    {describe(entry)}
                  </span>
                  <span className="block text-xs text-ash">
                    {formatStamp(entry.at)}
                    {entry.outcome !== "ok" && `. ${OUTCOME_NOTE[entry.outcome] ?? entry.outcome}`}
                  </span>
                </p>
                {entry.changeId && entry.outcome === "ok" && (
                  <button type="button" onClick={() => undo(entry)} className={quietButton} data-testid={`undo-${entry.changeId}`}>
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="type-wide mb-3 text-2xl">Trash</h2>
        {trash.length === 0 ? (
          <p className="text-ash">Nothing removed.</p>
        ) : (
          <ul className={`${panelClass} divide-y divide-line`} data-testid="trash">
            {trash.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <p className="min-w-0">
                  <span className="block truncate">{entry.label}</span>
                  <span className="block text-xs text-ash">{SECTION_LABEL[entry.section]}</span>
                </p>
                <button
                  type="button"
                  onClick={() => act(() => callOp("restore_item", { id: entry.id, idempotencyKey: newIdempotencyKey() }))}
                  className={quietButton}
                  data-testid={`restore-${entry.id}`}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="type-wide mb-1 text-2xl">Agents</h2>
        <p className="mb-3 text-sm text-ash">
          Assistants that can read or change this trip for you. Each has its own access, separate from the trip password.
        </p>
        {agents.length === 0 ? (
          <p className="text-ash">No agent is connected.</p>
        ) : (
          <ul className={`${panelClass} divide-y divide-line`} data-testid="agents">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <p className="min-w-0">
                  <span className="block font-semibold">{agent.name}</span>
                  <span className="block text-xs text-ash">{agent.revokedAt ? "Revoked" : agent.scopes.join(", ")}</span>
                </p>
                {!agent.revokedAt && (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Revoke ${agent.name}? It loses access right away.`)) {
                        void act(() => callOp("revoke_agent", { agentId: agent.id, confirm: true }));
                      }
                    }}
                    className="rounded-md border border-danger px-3 py-2 text-sm font-semibold text-danger"
                    data-testid={`revoke-${agent.id}`}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="type-wide mb-3 text-2xl">This device</h2>
        <div className={`${panelClass} space-y-3 px-4 py-4`}>
          <p className="text-sm">
            Signed in as <span className="font-semibold">{signedInAs}</span>.
          </p>
          {!storage.durable && (
            <p className="text-sm text-ash" data-testid="storage-note">
              Storage: local development fixture. Changes are lost when the server restarts and are not shared between devices.
            </p>
          )}
          {fixturePasswordInUse && (
            <p className="text-sm text-ash">Password: local development fixture, not a real password.</p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => signOut(false).finally(leaveToSignIn)}
              className={quietButton}
              data-testid="sign-out"
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Sign out every phone and computer? Everyone signs in again with the trip password.")) {
                  void signOut(true).finally(leaveToSignIn);
                }
              }}
              className={quietButton}
              data-testid="sign-out-everywhere"
            >
              Sign out every device
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
