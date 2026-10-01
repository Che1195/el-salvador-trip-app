import { describe, expect, it, vi } from "vitest";
import { loadConfig, resolveDeployment } from "@/server/config";
import { buildDeps } from "@/server/deps";
import { hashPassword, verifyPassword } from "@/server/password";
import { seedSampleTrip } from "@/server/sample-data";
import { MemoryFixtureStore } from "@/server/store/memory";

const FAKE_SECRET = "x".repeat(40); // Test value only; not a real signing key.

describe("environment detection", () => {
  it("treats anything that looks deployed as production unless it is a known preview", () => {
    expect(resolveDeployment({ NODE_ENV: "development" })).toBe("local");
    expect(resolveDeployment({ NODE_ENV: "test" })).toBe("local");
    expect(resolveDeployment({ NODE_ENV: "production" })).toBe("production");
    expect(resolveDeployment({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
    expect(resolveDeployment({ VERCEL: "1", VERCEL_ENV: "production" })).toBe("production");
    expect(resolveDeployment({ VERCEL: "1", VERCEL_ENV: "something-new" })).toBe("production");
    expect(resolveDeployment({ VERCEL: "1" })).toBe("production");
  });
});

describe("production fails closed", () => {
  it("has no sign-in, no storage and no agent access when nothing is configured", async () => {
    const deps = await buildDeps({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" });
    expect(deps.config.auth.ready).toBe(false);
    expect(deps.config.storage.mode).toBe("unconfigured");
    expect(deps.store).toBeNull();
    expect(deps.agentAuth.mode).toBe("disabled");
  });

  it("never uses the fixture store, fixture password or developer-token agent in production", async () => {
    const deps = await buildDeps({
      VERCEL: "1",
      VERCEL_ENV: "production",
      NODE_ENV: "production",
      TRIP_FIXTURE_PREVIEW: "1",
      MCP_DEV_FIXTURE_TOKEN: "t".repeat(40),
    });
    expect(deps.store).toBeNull();
    expect(deps.config.auth.ready).toBe(false);
    expect(deps.agentAuth.mode).toBe("disabled");
    // Configuration never carries a developer token outside local development.
    expect(deps.config.agentAuth).toEqual({ mode: "keys", localFixtureCredentialHash: null });
  });

  it("refuses to construct fixtures for production directly", async () => {
    expect(() => new MemoryFixtureStore("production")).toThrow();
    const store = new MemoryFixtureStore("preview");
    Object.defineProperty(store, "scope", { value: "production" });
    await expect(seedSampleTrip(store, "trip_1", new Date())).rejects.toThrow();
  });

  it("rejects a short signing secret or a weak or malformed password hash", async () => {
    const weak = await hashPassword("pw", { N: 2 ** 10, r: 8, p: 1 });
    const strong = await hashPassword("pw", { N: 2 ** 14, r: 8, p: 1 });
    const base = { VERCEL: "1", VERCEL_ENV: "production" };
    expect((await loadConfig({ ...base, SESSION_SECRET: "short", TRIP_PASSWORD_HASH: strong })).auth.ready).toBe(false);
    expect((await loadConfig({ ...base, SESSION_SECRET: FAKE_SECRET, TRIP_PASSWORD_HASH: weak })).auth.ready).toBe(false);
    expect((await loadConfig({ ...base, SESSION_SECRET: FAKE_SECRET, TRIP_PASSWORD_HASH: "plaintext" })).auth.ready).toBe(false);
    expect((await loadConfig({ ...base, SESSION_SECRET: FAKE_SECRET })).auth.ready).toBe(false);
    const ok = await loadConfig({ ...base, SESSION_SECRET: FAKE_SECRET, TRIP_PASSWORD_HASH: strong });
    expect(ok.auth.ready).toBe(true);
    expect(ok.auth.ready && ok.auth.cookie).toEqual({ name: "__Host-trip_session", secure: true });
    expect(ok.auth.ready && ok.auth.fixture).toBe(false);
  });
});

describe("preview is separate from production", () => {
  it("only gets the sample fixture when it opts in, and tags it as preview data", async () => {
    const base = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" };
    expect((await buildDeps(base)).store).toBeNull();
    const optedIn = await buildDeps({ ...base, TRIP_FIXTURE_PREVIEW: "1" });
    expect(optedIn.store?.kind).toBe("memory-fixture");
    expect(optedIn.store?.scope).toBe("preview");
    expect(optedIn.store?.durable).toBe(false);
    // Still no sign-in without its own secrets. Agent keys are the only way in
    // for agents, and none exists until a signed-in person creates one.
    expect(optedIn.config.auth.ready).toBe(false);
    expect(optedIn.agentAuth.mode).toBe("keys");
  });

  it("refuses a store whose data belongs to a different environment", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const productionStore = Object.assign(new MemoryFixtureStore("preview"), {});
    Object.defineProperty(productionStore, "scope", { value: "production" });
    const preview = await buildDeps({ VERCEL: "1", VERCEL_ENV: "preview" }, undefined, async () => productionStore);
    expect(preview.store).toBeNull();

    const previewStore = new MemoryFixtureStore("preview");
    const production = await buildDeps({ VERCEL: "1", VERCEL_ENV: "production" }, undefined, async () => previewStore);
    expect(production.store).toBeNull();
    const local = await buildDeps({ NODE_ENV: "development" }, undefined, async () => previewStore);
    expect(local.store).toBeNull();

    const matching = await buildDeps({ VERCEL: "1", VERCEL_ENV: "preview" }, undefined, async () => previewStore);
    expect(matching.store).toBe(previewStore);
    expect(logged).toHaveBeenCalledTimes(3);
    logged.mockRestore();
  });

  it("trusts only its own deployment origins", async () => {
    const preview = await loadConfig({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "app-abc123.vercel.app",
      VERCEL_BRANCH_URL: "app-git-feature.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example.com",
    });
    expect(preview.trustedOrigins).toEqual(["https://app-abc123.vercel.app", "https://app-git-feature.vercel.app"]);
    expect(preview.trustLoopbackRequestOrigin).toBe(false);
  });
});

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse", { N: 2 ** 10, r: 8, p: 1 });
    expect(hash.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsf", hash)).toBe(false);
    expect(await verifyPassword("correct horse", "not-a-hash")).toBe(false);
  });
});
