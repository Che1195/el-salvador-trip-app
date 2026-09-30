"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, callOp, newIdempotencyKey } from "./api";
import { Editor } from "./Editor";
import { blankValues } from "./forms";

/** Shown to a signed-in person while the trip has no record yet. */
export function TripSetup() {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);

  async function save(data: Record<string, unknown>): Promise<string | null> {
    try {
      await callOp("create_trip", { data, idempotencyKey: editing });
    } catch (error) {
      return error instanceof ApiError ? error.message : "Could not save. Try again.";
    }
    setEditing(null);
    router.refresh();
    return null;
  }

  return (
    <main className="flex h-dvh items-center justify-center px-6">
      <div className="max-w-sm">
        <h1 className="type-wide text-2xl">Set up your trip</h1>
        <p className="mt-3 text-ash">
          Nothing is stored yet. Add the trip&apos;s name, destination and dates to start planning.
        </p>
        <button
          type="button"
          onClick={() => setEditing(newIdempotencyKey())}
          className="mt-5 rounded-md bg-anil px-4 py-3 font-semibold text-white"
          data-testid="setup-trip"
        >
          Add trip details
        </button>
      </div>
      {editing && (
        <Editor
          key={editing}
          kind="trip"
          itemId={null}
          initial={blankValues("trip")}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}
