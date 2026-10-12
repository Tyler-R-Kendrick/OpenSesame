import { defineConfig } from "vitest/config";

// Unit and pact tests sit beside the runner they test. The source-reading
// pacts under tests/ run under node:test.
export default defineConfig({
  test: {
    include: ["runner/**/*.test.ts"],
    environment: "node",
    // Multi-step walks share a tick with the fake Host; under a saturated CI
    // runner a single walk can need more than vitest's 5s default without any
    // assertion being wrong.
    testTimeout: 15_000,
  },
});
