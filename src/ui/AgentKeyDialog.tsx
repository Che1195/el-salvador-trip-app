"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AgentSummary } from "@/domain/model";
import { ApiError, callOp } from "./api";

export const AGENT_PRESETS = [
  {
    value: "full",
    label: "Add and edit everything",
    help: "Read the whole trip and add or edit items in every list. Can't remove anything.",
  },
  {
    value: "packing",
    label: "Packing list only",
    help: "Read the packing list, tick items, and add or edit packing items.",
  },
  {
    value: "read",
    label: "Read only",
    help: "Read the trip and change nothing.",
  },
] as const;

type Preset = (typeof AGENT_PRESETS)[number]["value"];

interface Created {
  agent: AgentSummary;
  key: string;
}

const inputClass = "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-ink";

/**
 * Creates an agent and shows its key exactly once. The key lives only in this
 * component's state: it is never written to browser storage, and closing the
 * dialog unmounts the component, which discards it.
 */
export function AgentKeyDialog({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<Preset>("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<"key" | "address" | null>(null);
  // Only ever rendered in the browser, after a click, so window is available.
  const address = `${window.location.origin}/api/mcp`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === "") {
      setError("Give the agent a name, for example Melo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await callOp<{ agent: AgentSummary; key: string }>("create_agent", {
        name: name.trim(),
        preset,
        confirm: true,
      });
      setCreated({ agent: result.agent, key: result.key });
      onCreated();
    } catch (problem) {
      // A clear refusal (bad name, duplicate, limit) means nothing was created.
      // A lost connection or a server error leaves it unknown, and retrying
      // could create a second agent, so say so instead of retrying.
      const unknownOutcome = !(problem instanceof ApiError) || problem.status === 0 || problem.status >= 500;
      if (unknownOutcome) {
        setError(
          "The answer didn't arrive, so the agent may have been created without you seeing its key. Close this, check the Agents list, and if it's there, revoke it and create it again.",
        );
        onCreated();
      } else {
        setError(problem.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: "key" | "address") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setError("Copying failed. Select the text and copy it by hand.");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby={`${formId}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      data-testid="agent-dialog"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-3 bg-anil px-4 py-3 text-white">
          <h2 id={`${formId}-heading`} className="type-wide text-lg">
            {created ? `Key for ${created.agent.name}` : "Create agent"}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm underline" data-testid="agent-dialog-close">
            {created ? "Done" : "Cancel"}
          </button>
        </header>

        {created ? (
          <div className="flex-1 space-y-5 overflow-y-auto overflow-x-clip px-4 py-5" data-testid="agent-created">
            <p className="rounded-md bg-maiz px-3 py-2 text-sm font-semibold text-ink">
              Copy this key now. It won&apos;t be shown again.
            </p>

            <div className="space-y-1.5">
              <p className="text-sm font-semibold">Key</p>
              <p className="break-all rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-sm" data-testid="agent-key">
                {created.key}
              </p>
              <button type="button" onClick={() => copy(created.key, "key")} className="rounded-md bg-anil px-4 py-2.5 text-sm font-semibold text-white">
                {copied === "key" ? "Copied" : "Copy key"}
              </button>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-semibold">MCP address</p>
              <p className="break-all rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-sm">{address}</p>
              <button type="button" onClick={() => copy(address, "address")} className="rounded-md border border-line px-4 py-2.5 text-sm font-semibold text-anil">
                {copied === "address" ? "Copied" : "Copy address"}
              </button>
            </div>

            <div className="space-y-2 text-sm">
              <p className="font-semibold">Connect the agent</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>Open the agent&apos;s MCP or connector settings and add a server with the address above.</li>
                <li>
                  For authentication, choose a bearer token or header and paste the key. As a header it is{" "}
                  <span className="font-mono">Authorization: Bearer</span> followed by the key.
                </li>
                <li>Ask the agent to read the trip. Its changes appear under Activity with its name.</li>
              </ol>
              {error && (
                <p role="alert" className="rounded-md border border-danger bg-surface px-3 py-2 text-danger">
                  {error}
                </p>
              )}
              <p className="text-ash">
                Treat the key like a password: only paste it into the agent&apos;s connection settings, never into a chat. If it
                leaks, revoke this agent and create a new one.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-1 flex-col">
            <div className="flex-1 space-y-5 overflow-y-auto overflow-x-clip px-4 py-5">
              <div className="space-y-1.5">
                <label htmlFor={`${formId}-name`} className="block text-sm font-semibold">
                  Name
                </label>
                <input
                  id={`${formId}-name`}
                  value={name}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                  className={inputClass}
                  data-testid="agent-name"
                />
                <p className="text-sm text-ash">Shown next to everything this agent changes.</p>
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-semibold">What it may do</legend>
                {AGENT_PRESETS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 ${preset === option.value ? "border-anil bg-anil-wash" : "border-line bg-surface"}`}
                  >
                    <input
                      type="radio"
                      name={`${formId}-preset`}
                      value={option.value}
                      checked={preset === option.value}
                      onChange={() => setPreset(option.value)}
                      className="mt-1 size-5 accent-anil"
                      data-testid={`agent-preset-${option.value}`}
                    />
                    <span>
                      <span className="block font-semibold">{option.label}</span>
                      <span className="block text-sm text-ash">{option.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {error && (
                <p role="alert" className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger" data-testid="agent-error">
                  {error}
                </p>
              )}
            </div>
            <footer className="border-t border-line bg-surface px-4 py-3">
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-anil px-4 py-3 font-semibold text-white disabled:opacity-60"
                data-testid="agent-create"
              >
                {busy ? "Creating" : "Create agent and show key"}
              </button>
            </footer>
          </form>
        )}
      </div>
    </dialog>
  );
}
