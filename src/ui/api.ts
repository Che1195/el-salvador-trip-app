// Browser-side calls to the app's own API. The session cookie is HttpOnly, so
// this code never sees or stores a credential; it only sends same-origin requests.

import type { ActivityEntry, TripSnapshot } from "@/domain/model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: init ? { "Content-Type": "application/json", "X-Trip-Request": "1" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "Could not reach the server. Check your connection and try again.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(
      response.status,
      body.error ?? "unknown",
      body.message ?? "Something went wrong.",
      body.details,
    );
  }
  return payload as T;
}

/**
 * Leaves for the sign-in page with a full document load, not a client-side
 * route change, so trip data held in this page's memory is discarded.
 */
export function leaveToSignIn(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload is the point
  window.location.assign("/login");
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function fetchTrip(): Promise<TripSnapshot> {
  return request<TripSnapshot>("/api/trip");
}

export async function fetchActivity(): Promise<ActivityEntry[]> {
  return (await request<{ entries: ActivityEntry[] }>("/api/trip/activity?limit=60")).entries;
}

export function callOp<T = Record<string, unknown>>(op: string, input: Record<string, unknown>): Promise<T> {
  return request<T>("/api/trip/ops", { method: "POST", body: { op, input } });
}

export function signIn(password: string, label: string): Promise<{ ok: true }> {
  return request("/api/auth/login", { method: "POST", body: label ? { password, label } : { password } });
}

export function signOut(everywhere: boolean): Promise<{ ok: true }> {
  return request(everywhere ? "/api/auth/logout-everywhere" : "/api/auth/logout", { method: "POST", body: {} });
}
