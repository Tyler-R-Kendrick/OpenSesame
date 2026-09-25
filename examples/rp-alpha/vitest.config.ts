import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The entrypoint test imports main.js cold, which transforms the whole
    // relying party: well under a second here, past Vitest's 5 s default on
    // a loaded CI runner. That is a budget, not a bug.
    testTimeout: 30_000,
  },
});
