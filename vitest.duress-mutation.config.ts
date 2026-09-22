import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/pages/src/lib/duress/redteam/unlock-gates.test.ts",
      "apps/pages/src/lib/duress/redteam/unlock-continue.test.ts",
      "apps/pages/src/lib/duress/redteam/unlock-duress.behavior.test.ts",
      "apps/pages/src/lib/duress/redteam/unlock-duress.pact.test.ts",
      "apps/pages/src/lib/duress/redteam/unlock-uv-prf.bridge.test.ts",
      "apps/pages/src/lib/duress/redteam/gaps.honest.test.ts",
    ],
    // Pages' own test setup: installs the app-core host (ADR 0133).
    setupFiles: ["apps/pages/src/host/test-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
