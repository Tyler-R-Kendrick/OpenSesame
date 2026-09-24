import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Globs below are repository-relative; the config lives in tools/mutation/.
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  test: {
    environment: "node",
    include: [
      "packages/app-core/src/lib/duress/redteam/unlock-gates.test.ts",
      "packages/app-core/src/lib/duress/redteam/unlock-continue.test.ts",
      "packages/app-core/src/lib/duress/redteam/unlock-duress.behavior.test.ts",
      "packages/app-core/src/lib/duress/redteam/unlock-duress.pact.test.ts",
      "packages/app-core/src/lib/duress/redteam/unlock-uv-prf.bridge.test.ts",
      "apps/pages/src/lib/duress/redteam/gaps.honest.test.ts",
    ],
    // Pages' own test setup: installs the app-core host (ADR 0133).
    setupFiles: ["apps/pages/src/host/test-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
