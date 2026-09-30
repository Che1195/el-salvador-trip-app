// Session check for server-rendered pages. Same verification as the API
// routes; only the way the cookie is read differs.

import "server-only";
import { cookies } from "next/headers";
import type { Deps } from "./deps";
import { DomainError } from "./errors";
import { authenticateSessionToken, type WebSession } from "./web-auth";

export type PageSession =
  | { state: "ok"; session: WebSession }
  | { state: "signed-out" }
  | { state: "unavailable" };

export async function getPageSession(deps: Deps): Promise<PageSession> {
  const auth = deps.config.auth;
  if (!auth.ready || !deps.store) return { state: "unavailable" };
  const token = (await cookies()).get(auth.cookie.name)?.value ?? null;
  try {
    return { state: "ok", session: await authenticateSessionToken(token, deps) };
  } catch (error) {
    if (error instanceof DomainError && error.code === "unauthenticated") return { state: "signed-out" };
    if (error instanceof DomainError && error.code === "unavailable") return { state: "unavailable" };
    throw error;
  }
}
