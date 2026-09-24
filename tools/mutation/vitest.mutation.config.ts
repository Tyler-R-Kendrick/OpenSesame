import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Globs below are repository-relative; the config lives in tools/mutation/.
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  test: {
    environment: "node",
    include: [
      "apps/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/tests/**/*.test.ts",
    ],
    // Match apps/control-plane/vitest.config.ts so related Identity suites
    // can boot under Stryker without a shell export.
    env: {
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
    },
    // Pages' own test setup: installs the app-core host (ADR 0133).
    setupFiles: ["apps/pages/src/host/test-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
