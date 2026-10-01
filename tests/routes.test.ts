import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_FIXTURE_PASSWORD, loadConfig, SESSION_TTL_SECONDS } from "@/server/config";
import { buildDeps, type Deps } from "@/server/deps";
import {
  handleActivity,
  handleGetTrip,
  handleHealth,
  handleLogin,
  handleLogout,
  handleLogoutEverywhere,
  handleOperation,
  handleSessionInfo,
} from "@/server/handlers";
import { hashPassword } from "@/server/password";
import { sessionCookie, signSession } from "@/server/session";
import { makeHarness, makeRequest, signIn, type Harness, type RequestOptions } from "./support/harness";

type Handler = (request: Request, deps: Deps) => Promise<Response>;
type Method = "GET" | "POST" | "DELETE";

// Every API route in the app, and who may call it. "session" routes return or
// change trip data and must refuse anyone without a valid web session.
// "agent" routes have their own credential check (covered in mcp.test.ts).
// "public" routes return no trip data: sign-in, the health report, and the
// OAuth metadata document (which is 404 while agent access is off).
const ROUTE_TABLE: Record<string, Partial<Record<Method, "public" | "session" | "agent">>> = {
  ".well-known/oauth-protected-resource": { GET: "public" },
  ".well-known/oauth-protected-resource/[...path]": { GET: "public" },
  "api/auth/login": { POST: "public" },
  "api/auth/logout": { POST: "session" },
  "api/auth/logout-everywhere": { POST: "session" },
  "api/auth/session": { GET: "session" },
  "api/health": { GET: "public" },
  "api/mcp": { POST: "agent", GET: "agent", DELETE: "agent" },
  "api/trip": { GET: "session" },
  "api/trip/activity": { GET: "session" },
  "api/trip/ops": { POST: "session" },
};

const SESSION_ROUTES: { name: string; method: Method; path: string; handler: Handler; body?: unknown }[] = [
  { name: "read trip", method: "GET", path: "/api/trip", handler: handleGetTrip },
  { name: "run operation", method: "POST", path: "/api/trip/ops", handler: handleOperation, body: { op: "get_trip" } },
  { name: "read activity", method: "GET", path: "/api/trip/activity", handler: handleActivity },
  { name: "session info", method: "GET", path: "/api/auth/session", handler: handleSessionInfo },
  { name: "sign out", method: "POST", path: "/api/auth/logout", handler: handleLogout, body: {} },
  { name: "sign out everywhere", method: "POST", path: "/api/auth/logout-everywhere", handler: handleLogoutEverywhere, body: {} },
];

// Globs skip dot-folders unless the pattern names them, hence the second pattern.
const routeModules = {
  ...import.meta.glob("../src/app/**/route.ts"),
  ...import.meta.glob("../src/app/.well-known/**/route.ts"),
} as Record<string, () => Promise<Record<string, unknown>>>;

function routeFilesOnDisk(): string[] {
  const root = join(process.cwd(), "src", "app");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") found.push(relative(root, dir).split(sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

function call(route: (typeof SESSION_ROUTES)[number], h: Harness, options: RequestOptions = {}) {
  return route.handler(
    makeRequest(route.path, { method: route.method, body: route.body, ...options }),
    h.deps,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route inventory", () => {
  it("lists every route file and every exported method", async () => {
    expect(routeFilesOnDisk()).toEqual(Object.keys(ROUTE_TABLE).sort());
    for (const [path, methods] of Object.entries(ROUTE_TABLE)) {
      const mod = await routeModules[`../src/app/${path}/route.ts`]();
      const exported = Object.keys(mod).filter((name) => /^[A-Z]+$/.test(name)).sort();
      expect(exported, path).toEqual(Object.keys(methods).sort());
      expect(mod.dynamic, path).toBe("force-dynamic");
    }
  });

  it("has a session test case for every session route", () => {
    const tabled = Object.entries(ROUTE_TABLE).flatMap(([path, methods]) =>
      Object.entries(methods).filter(([, access]) => access === "session").map(([method]) => `${method} /${path}`),
    );
    expect(SESSION_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(tabled.sort());
  });

  it("serves no OAuth metadata from the real routes while agents use keys", async () => {
    for (const path of [".well-known/oauth-protected-resource", ".well-known/oauth-protected-resource/[...path]"]) {
      const mod = await routeModules[`../src/app/${path}/route.ts`]();
      const handler = mod.GET as (request: Request) => Promise<Response>;
      const response = await handler(makeRequest("/.well-known/oauth-protected-resource/api/mcp"));
      expect(response.status, path).toBe(404);
    }
  });

  it("refuses the real route exports when there is no session", async () => {
    for (const [path, methods] of Object.entries(ROUTE_TABLE)) {
      const mod = await routeModules[`../src/app/${path}/route.ts`]();
      for (const [method, access] of Object.entries(methods)) {
        if (access === "public") continue;
        const handler = mod[method] as (request: Request) => Promise<Response>;
        const response = await handler(makeRequest(`/${path}`, { method, body: {} }));
        // Session routes: 401. Agent route: 401 (no key) or 405 (wrong method).
        const expected = access === "session" ? [401] : [401, 405];
        expect(expected, `${method} /${path}`).toContain(response.status);
        expect(response.headers.get("cache-control"), path).toContain("no-store");
      }
    }
  });
});

describe.each(SESSION_ROUTES)("session required: $name", (route) => {
  it("accepts a valid session (control case)", async () => {
    const h = await makeHarness();
    const response = await call(route, h, { cookie: await signIn(h) });
    expect(response.status).toBe(200);
  });

  it("rejects a request with no cookie", async () => {
    const h = await makeHarness();
    const response = await call(route, h);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated", message: "Sign in to continue." });
  });

  it("rejects a tampered payload, a tampered signature and a foreign signature", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const [name, token] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
    const [version, payload, signature] = token.split(".");

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const longer = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 999_999 })).toString("base64url");
    const flipped = signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
    const forged = signSession(claims, Buffer.from("a-different-signing-key-for-this-test"));

    for (const bad of [`${version}.${longer}.${signature}`, `${version}.${payload}.${flipped}`, forged, "garbage", ""]) {
      const response = await call(route, h, { cookie: `${name}=${bad}` });
      expect(response.status, bad.slice(0, 12)).toBe(401);
    }
  });

  it("rejects an expired session", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    h.advance(SESSION_TTL_SECONDS * 1000 - 1000);
    expect((await call(route, h, { cookie })).status).toBe(200);
    h.advance(2000);
    expect((await call(route, h, { cookie })).status).toBe(401);
  });

  it("rejects a correctly signed token whose server-side session does not exist", async () => {
    const h = await makeHarness();
    const auth = h.deps.config.auth;
    if (!auth.ready) throw new Error("fixture auth should be ready");
    const nowSeconds = Math.floor(h.now().getTime() / 1000);
    const token = signSession(
      { sid: "never-created", tid: h.tripId, iat: nowSeconds, exp: nowSeconds + 600, pv: auth.passwordVersion },
      auth.sessionSecret,
    );
    expect((await call(route, h, { cookie: `${auth.cookie.name}=${token}` })).status).toBe(401);
  });

  it("rejects a session whose server-side record has expired, even if the token has not", async () => {
    const h = await makeHarness();
    const auth = h.deps.config.auth;
    if (!auth.ready) throw new Error("fixture auth should be ready");
    const nowSeconds = Math.floor(h.now().getTime() / 1000);
    await h.store.transaction((tx) =>
      tx.putSession({
        id: "record-expired",
        tripId: h.tripId,
        label: "Old",
        createdAt: new Date(h.now().getTime() - 60_000).toISOString(),
        expiresAt: new Date(h.now().getTime() - 1).toISOString(),
        revokedAt: null,
        epoch: 0,
      }),
    );
    const token = signSession(
      { sid: "record-expired", tid: h.tripId, iat: nowSeconds, exp: nowSeconds + 600, pv: auth.passwordVersion },
      auth.sessionSecret,
    );
    expect((await call(route, h, { cookie: `${auth.cookie.name}=${token}` })).status).toBe(401);
  });

  it("rejects the old cookie after sign-out", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const out = await handleLogout(makeRequest("/api/auth/logout", { method: "POST", cookie, body: {} }), h.deps);
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call(route, h, { cookie })).status).toBe(401);
  });

  it("rejects every device's cookie after sign-out everywhere", async () => {
    const h = await makeHarness();
    const phone = await signIn(h, "Phone");
    const laptop = await signIn(h, "Laptop");
    const out = await handleLogoutEverywhere(
      makeRequest("/api/auth/logout-everywhere", { method: "POST", cookie: phone, body: {} }),
      h.deps,
    );
    expect(out.status).toBe(200);
    expect((await call(route, h, { cookie: phone })).status).toBe(401);
    expect((await call(route, h, { cookie: laptop })).status).toBe(401);
    // A fresh sign-in works again.
    expect((await call(route, h, { cookie: await signIn(h) })).status).toBe(200);
  });

  it("answers 503 with no data when production is not configured", async () => {
    const deps = await buildDeps({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" });
    const response = await route.handler(
      makeRequest(route.path, {
        method: route.method,
        body: route.body,
        origin: "https://app.example.com",
        cookie: "__Host-trip_session=v1.e30.AAAA",
      }),
      deps,
    );
    // Mutating routes are refused at the origin check first (no origin is trusted yet).
    expect([503, 403]).toContain(response.status);
    expect(await response.text()).not.toMatch(/Sample|Muestra|itinerary/);
  });
});

describe("sessions end when the password changes", () => {
  it("rejects a session issued under the previous password hash", async () => {
    const secret = "s".repeat(40); // Test value only.
    const first = await hashPassword("first password", { N: 2 ** 10, r: 8, p: 1 });
    const second = await hashPassword("second password", { N: 2 ** 10, r: 8, p: 1 });
    const before = await makeHarness({ SESSION_SECRET: secret, TRIP_PASSWORD_HASH: first });
    const login = await handleLogin(
      makeRequest("/api/auth/login", { method: "POST", body: { password: "first password" } }),
      before.deps,
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await handleGetTrip(makeRequest("/api/trip", { cookie }), before.deps)).status).toBe(200);

    const rotated = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: secret, TRIP_PASSWORD_HASH: second });
    const after = { ...before.deps, config: rotated };
    expect((await handleGetTrip(makeRequest("/api/trip", { cookie }), after)).status).toBe(401);
  });
});

describe("sign-in", () => {
  it("sets an HttpOnly, SameSite cookie and never returns the token in the body", async () => {
    const h = await makeHarness();
    const response = await handleLogin(
      makeRequest("/api/auth/login", { method: "POST", body: { password: LOCAL_FIXTURE_PASSWORD } }),
      h.deps,
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^trip_session=v1\./);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("uses a Secure __Host- cookie in deployed environments", async () => {
    const hash = await hashPassword("pw", { N: 2 ** 14, r: 8, p: 1 });
    const config = await loadConfig({ VERCEL: "1", VERCEL_ENV: "production", SESSION_SECRET: "k".repeat(40), TRIP_PASSWORD_HASH: hash });
    if (!config.auth.ready) throw new Error("expected auth to be ready");
    const cookie = sessionCookie(config.auth.cookie, "token", 60);
    expect(cookie).toMatch(/^__Host-trip_session=token; /);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Domain=");
  });

  it("rejects a wrong password with a generic message", async () => {
    const h = await makeHarness();
    const response = await handleLogin(
      makeRequest("/api/auth/login", { method: "POST", body: { password: "not the password" } }),
      h.deps,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "invalid_credentials", message: "That password is not right." });
  });

  it("refuses the local fixture password when real secrets are configured", async () => {
    const hash = await hashPassword("the real one", { N: 2 ** 10, r: 8, p: 1 });
    const h = await makeHarness({ SESSION_SECRET: "k".repeat(40), TRIP_PASSWORD_HASH: hash });
    const response = await handleLogin(
      makeRequest("/api/auth/login", { method: "POST", body: { password: LOCAL_FIXTURE_PASSWORD } }),
      h.deps,
    );
    expect(response.status).toBe(401);
  });

  it("rate limits repeated attempts per address and recovers after the window", async () => {
    const h = await makeHarness();
    const attempt = (password: string, address = "203.0.113.7") =>
      handleLogin(
        makeRequest("/api/auth/login", { method: "POST", body: { password }, headers: { "x-forwarded-for": address } }),
        h.deps,
      );
    for (let i = 0; i < 8; i++) expect((await attempt("wrong")).status).toBe(401);
    const blocked = await attempt(LOCAL_FIXTURE_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // Another address is not locked out by the first one.
    expect((await attempt(LOCAL_FIXTURE_PASSWORD, "198.51.100.9")).status).toBe(200);
    h.advance(15 * 60 * 1000);
    expect((await attempt(LOCAL_FIXTURE_PASSWORD)).status).toBe(200);
  });

  it("caps total attempts across all addresses", async () => {
    const h = await makeHarness();
    let last = 0;
    for (let i = 0; i < 101; i++) {
      const response = await handleLogin(
        makeRequest("/api/auth/login", { method: "POST", rawBody: "{}", headers: { "x-forwarded-for": `10.0.${i}.1` } }),
        h.deps,
      );
      last = response.status;
    }
    expect(last).toBe(429);
  });
});

describe("cross-site request protection", () => {
  const MUTATING: { name: string; path: string; handler: Handler; body: unknown }[] = [
    { name: "sign in", path: "/api/auth/login", handler: handleLogin, body: { password: LOCAL_FIXTURE_PASSWORD } },
    { name: "sign out", path: "/api/auth/logout", handler: handleLogout, body: {} },
    { name: "sign out everywhere", path: "/api/auth/logout-everywhere", handler: handleLogoutEverywhere, body: {} },
    { name: "run operation", path: "/api/trip/ops", handler: handleOperation, body: { op: "add_item", input: { section: "notes", data: { title: "x", body: "" } } } },
  ];

  it.each(MUTATING)("$name refuses a wrong, missing or cross-site origin", async (route) => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const before = await h.store.transaction((tx) => tx.listEntities(h.tripId, "notes"));
    const attempts: RequestOptions[] = [
      { origin: "https://evil.example" },
      { origin: null },
      { origin: "http://localhost:9999" },
      { origin: "null" },
      { headers: { "sec-fetch-site": "cross-site" } },
      { headers: { "sec-fetch-site": "same-site" } },
      { headers: { "X-Trip-Request": "" } },
    ];
    for (const options of attempts) {
      const response = await route.handler(
        makeRequest(route.path, { method: "POST", cookie, body: route.body, ...options }),
        h.deps,
      );
      expect(response.status, JSON.stringify(options)).toBe(403);
      expect((await response.json()).error).toBe("untrusted_origin");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    // Nothing was written and the session still works.
    expect(await h.store.transaction((tx) => tx.listEntities(h.tripId, "notes"))).toHaveLength(before.length);
    expect((await handleGetTrip(makeRequest("/api/trip", { cookie }), h.deps)).status).toBe(200);
  });

  it("in a deployment, trusts the configured origin and not the request's own host", async () => {
    const hash = await hashPassword("pw", { N: 2 ** 10, r: 8, p: 1 });
    const h = await makeHarness({ SESSION_SECRET: "k".repeat(40), TRIP_PASSWORD_HASH: hash });
    const config = { ...h.deps.config, trustedOrigins: ["https://trip.example.com"], trustLoopbackRequestOrigin: false };
    const deps = { ...h.deps, config };
    const login = (origin: string) =>
      handleLogin(makeRequest("/api/auth/login", { method: "POST", origin, body: { password: "pw" } }), deps);
    expect((await login("http://localhost:3000")).status).toBe(403);
    expect((await login("https://trip.example.com")).status).toBe(200);
  });
});

describe("request validation and limits", () => {
  async function post(h: Harness, cookie: string, options: RequestOptions) {
    return handleOperation(makeRequest("/api/trip/ops", { method: "POST", cookie, ...options }), h.deps);
  }

  it("rejects bodies that are not JSON, not valid, or too large", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    expect((await post(h, cookie, { rawBody: "op=get_trip", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await post(h, cookie, { rawBody: "{not json" })).status).toBe(400);
    expect((await post(h, cookie, { body: { op: "get_trip", extra: 1 } })).status).toBe(400);
    expect((await post(h, cookie, { body: { op: "no_such_operation" } })).status).toBe(400);
    const huge = { op: "add_item", input: { section: "notes", data: { title: "big", body: "x".repeat(40_000) } } };
    expect((await post(h, cookie, { body: huge })).status).toBe(413);
    expect((await post(h, cookie, { body: { op: "get_trip" }, headers: { "content-length": "999999" } })).status).toBe(413);
  });

  it("reports which fields are wrong without echoing their values", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const response = await post(h, cookie, {
      body: { op: "add_item", input: { section: "budget", data: { label: "PRIVATE-LABEL-VALUE", category: "lodging", unitCents: 12.5, quantity: 0, status: "paid", paid: false } } },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.error).toBe("validation_failed");
    expect(body.details.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(["quantity", "status", "unitCents"]);
    expect(text).not.toContain("PRIVATE-LABEL-VALUE");
  });

  it("rejects text with control characters and over-long fields", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const add = (data: unknown) => post(h, cookie, { body: { op: "add_item", input: { section: "notes", data } } });
    expect((await add({ title: "bad\u0000title", body: "" })).status).toBe(400);
    expect((await add({ title: "t".repeat(121), body: "" })).status).toBe(400);
    expect((await add({ title: "ok", body: "line one\nline two" })).status).toBe(200);
    expect((await add({ title: "ok", body: "", html: "<b>x</b>" })).status).toBe(400);
  });

  it("rate limits operations per session", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    let status = 0;
    for (let i = 0; i < 241; i++) status = (await post(h, cookie, { body: { op: "get_packing_list" } })).status;
    expect(status).toBe(429);
    h.advance(60_000);
    expect((await post(h, cookie, { body: { op: "get_packing_list" } })).status).toBe(200);
  });
});

describe("private data stays out of errors, logs and caches", () => {
  it("returns a bare 500 and logs no detail when storage throws", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = Object.create(h.store, {
      transaction: {
        value: async () => {
          throw new Error("row contained PRIVATE-TRIP-DETAIL");
        },
      },
    });
    const response = await handleGetTrip(makeRequest("/api/trip", { cookie }), { ...h.deps, store: failing });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE-TRIP-DETAIL");
    expect(JSON.parse(text)).toEqual({ error: "internal_error", message: "Something went wrong on our side." });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE-TRIP-DETAIL");
  });

  it("marks every response as not storable", async () => {
    const h = await makeHarness();
    const cookie = await signIn(h);
    const responses = [
      await handleGetTrip(makeRequest("/api/trip", { cookie }), h.deps),
      await handleGetTrip(makeRequest("/api/trip"), h.deps),
      await handleActivity(makeRequest("/api/trip/activity", { cookie }), h.deps),
      await handleHealth(makeRequest("/api/health"), h.deps),
    ];
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("exposes no trip data on the public health route", async () => {
    const h = await makeHarness();
    const body = await (await handleHealth(makeRequest("/api/health"), h.deps)).json();
    expect(body).toEqual({
      deployment: "local",
      signIn: "ready",
      storage: h.store.kind,
      durableStorage: h.store.durable,
      agentAccess: "keys",
      schemaVersion: h.store.schemaVersion,
      commit: null,
    });
  });

  it("names the deployed commit and the database's schema version, so a deploy can be checked from outside", async () => {
    const h = await makeHarness({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" });
    const body = await (await handleHealth(makeRequest("/api/health"), h.deps)).json();
    expect(body.commit).toBe("0123456");
    expect(body.schemaVersion).toBe(h.store.kind === "postgres" ? 2 : null);
    const odd = await makeHarness({ VERCEL_GIT_COMMIT_SHA: "not a sha; <script>" });
    expect((await (await handleHealth(makeRequest("/api/health"), odd.deps)).json()).commit).toBeNull();
  });
});
