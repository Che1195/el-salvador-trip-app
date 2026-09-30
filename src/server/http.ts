import "server-only";
import type { AppConfig } from "./config";
import { DomainError, statusForCode, type ErrorCode } from "./errors";
import { sha256Hex } from "./hash";

/** Headers for every API response: nothing here may be stored by a browser, proxy or CDN. */
export const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie, Authorization",
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Turns any thrown value into a response. A DomainError carries a message and
 * details written by this codebase. Anything else becomes a bare 500: the
 * underlying error could quote private data, so it is neither returned nor logged.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    const headers: Record<string, string> = {};
    const retryAfter = error.details?.retryAfterSeconds;
    if (error.code === "rate_limited" && typeof retryAfter === "number") {
      headers["Retry-After"] = String(retryAfter);
    }
    return jsonResponse(
      statusForCode(error.code),
      { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      headers,
    );
  }
  const code: ErrorCode = "internal_error";
  console.error("[trip-app] unexpected error:", error instanceof Error ? error.name : "unknown");
  return jsonResponse(500, { error: code, message: "Something went wrong on our side." });
}

export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DomainError("payload_too_large", "That request is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DomainError("payload_too_large", "That request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("validation_failed", "The request body is not valid UTF-8.");
  }
}

export function isJsonContentType(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!isJsonContentType(request)) {
    throw new DomainError("unsupported_media_type", "Send the request as application/json.");
  }
  const text = await readBodyText(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("validation_failed", "The request body is not valid JSON.");
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isTrustedOrigin(origin: string, request: Request, config: AppConfig): boolean {
  if (config.trustedOrigins.includes(origin)) return true;
  if (!config.trustLoopbackRequestOrigin) return false;
  try {
    const own = new URL(request.url);
    return LOOPBACK_HOSTS.has(own.hostname) && origin === own.origin;
  } catch {
    return false;
  }
}

/**
 * Guard for every cookie-authenticated request that changes something.
 * A cross-site page cannot pass it: the browser reports that page's origin,
 * marks the request cross-site, and cannot attach the custom header without
 * a CORS preflight this app never approves.
 */
export function assertTrustedMutation(request: Request, config: AppConfig): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const trusted =
    origin !== null &&
    isTrustedOrigin(origin, request, config) &&
    (fetchSite === null || fetchSite === "same-origin") &&
    request.headers.get("x-trip-request") === "1";
  if (!trusted) {
    throw new DomainError("untrusted_origin", "This request did not come from the app.");
  }
}

/** A stable, non-reversible key for the caller's network address, for rate limiting. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return sha256Hex(address).slice(0, 16);
}
