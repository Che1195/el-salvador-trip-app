"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, signIn } from "./api";

const inputClass = "w-full rounded-md border border-line bg-surface px-3 py-3 text-ink";

export function LoginForm({ fixturePassword }: { fixturePassword: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(password, label.trim());
      router.replace("/");
      router.refresh();
    } catch (problem) {
      setBusy(false);
      if (problem instanceof ApiError && problem.code === "rate_limited") {
        setError("Too many attempts. Wait 15 minutes and try again.");
      } else if (problem instanceof ApiError) {
        setError(problem.message);
      } else {
        setError("Could not sign in. Try again.");
      }
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="login-form">
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-semibold">
          Trip password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
          data-testid="login-password"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="label" className="block text-sm font-semibold">
          Name for this device <span className="font-normal text-ash">(optional)</span>
        </label>
        <input
          id="label"
          name="label"
          type="text"
          autoComplete="off"
          maxLength={40}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className={inputClass}
          data-testid="login-label"
        />
        <p className="text-sm text-ash">Shown next to your changes, so you can tell who edited what.</p>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger" data-testid="login-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-anil px-4 py-3 font-semibold text-white disabled:opacity-60" data-testid="login-submit">
        {busy ? "Signing in" : "Sign in"}
      </button>
      {fixturePassword && (
        <p className="rounded-md bg-maiz px-3 py-2 text-sm text-ink" data-testid="fixture-hint">
          Local development fixture. The password is <code className="font-semibold">{fixturePassword}</code> and the
          trip is sample data.
        </p>
      )}
    </form>
  );
}
