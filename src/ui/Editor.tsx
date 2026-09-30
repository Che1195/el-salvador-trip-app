"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { EntityKind } from "@/domain/model";
import { FORM_FIELDS, fromFormValues, ITEM_NOUN, type Field, type FormValues } from "./forms";

export interface EditorProps {
  kind: EntityKind;
  /** Null when adding a new item. */
  itemId: string | null;
  initial: FormValues;
  onSave(data: Record<string, unknown>): Promise<string | null>;
  onRemove?(): Promise<string | null>;
  onClose(): void;
}

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-ink placeholder:text-ash";

function FieldInput({
  field,
  id,
  value,
  onChange,
}: {
  field: Field;
  id: string;
  value: string | boolean;
  onChange(value: string | boolean): void;
}) {
  const text = typeof value === "string" ? value : "";
  const common = { id, name: field.key, "data-testid": `field-${field.key}` };
  switch (field.type) {
    case "checkbox":
      return (
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="size-6 accent-anil"
        />
      );
    case "select":
      return (
        <select {...common} value={text} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "textarea":
      return (
        <textarea
          {...common}
          value={text}
          maxLength={field.maxLength}
          rows={5}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      );
    default:
      return (
        <input
          {...common}
          type={field.type === "date" || field.type === "time" ? field.type : "text"}
          inputMode={field.type === "int" ? "numeric" : field.type === "money" ? "decimal" : undefined}
          value={text}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} ${field.type === "int" || field.type === "money" ? "nums" : ""}`}
        />
      );
  }
}

/** Full-screen editor on a phone, a centered panel on wider screens. */
export function Editor({ kind, itemId, initial, onSave, onRemove, onClose }: EditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noun = ITEM_NOUN[kind];
  const heading = kind === "trip" ? "Trip details" : `${itemId ? "Edit" : "Add"} ${noun}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = fromFormValues(kind, values);
    if (!parsed.ok) {
      setError(parsed.message);
      document.getElementById(`${formId}-${parsed.field}`)?.focus();
      return;
    }
    setBusy(true);
    const problem = await onSave(parsed.data);
    setBusy(false);
    if (problem) setError(problem);
  }

  async function remove() {
    if (!onRemove) return;
    if (!window.confirm(`Move this ${noun} to the trash? You can restore it from More.`)) return;
    setBusy(true);
    const problem = await onRemove();
    setBusy(false);
    if (problem) setError(problem);
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
      data-testid="editor"
    >
      <form onSubmit={submit} className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-3 bg-anil px-4 py-3 text-white">
          <h2 id={`${formId}-heading`} className="type-wide text-lg">
            {heading}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm underline" data-testid="editor-cancel">
            Cancel
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto overflow-x-clip px-4 py-5">
          {FORM_FIELDS[kind].map((field) => {
            const id = `${formId}-${field.key}`;
            const checkbox = field.type === "checkbox";
            return (
              <div key={field.key} className={checkbox ? "flex items-center gap-3" : "space-y-1.5"}>
                {checkbox && (
                  <FieldInput field={field} id={id} value={values[field.key]} onChange={(v) => setValues({ ...values, [field.key]: v })} />
                )}
                <label htmlFor={id} className="block text-sm font-semibold">
                  {field.label}
                  {!field.required && !checkbox && <span className="font-normal text-ash"> (optional)</span>}
                </label>
                {!checkbox && (
                  <FieldInput field={field} id={id} value={values[field.key]} onChange={(v) => setValues({ ...values, [field.key]: v })} />
                )}
                {field.hint && <p className="text-sm text-ash">{field.hint}</p>}
              </div>
            );
          })}
          {error && (
            <p role="alert" className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger" data-testid="editor-error">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-md bg-anil px-4 py-3 font-semibold text-white disabled:opacity-60"
            data-testid="editor-save"
          >
            {busy ? "Saving" : itemId || kind === "trip" ? "Save changes" : `Add ${noun}`}
          </button>
          {onRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="rounded-md border border-danger px-4 py-3 font-semibold text-danger disabled:opacity-60"
              data-testid="editor-remove"
            >
              Remove
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
