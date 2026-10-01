import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" throws outside a React server bundle; tests run the server code directly.
      "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
    },
  },
};

export default defineConfig({
  ...shared,
  test: {
    projects: [
      {
        ...shared,
        test: { name: "memory", environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
      },
      {
        // The same behavior tests again, with the Postgres store underneath.
        ...shared,
        test: {
          name: "postgres",
          environment: "node",
          include: [
            "tests/operations.test.ts",
            "tests/mcp.test.ts",
            "tests/routes.test.ts",
            "tests/oauth.test.ts",
            "tests/agent-keys.test.ts",
          ],
          env: { TRIP_TEST_STORE: "pglite" },
          testTimeout: 60000,
        },
      },
    ],
  },
});
