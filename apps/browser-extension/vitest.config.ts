import { defineConfig } from "vitest/config";

// Unit and pact tests sit beside the runner they test. The source-reading
// pacts under tests/ run under node:test.
export default defineConfig({
  test: {
    include: ["runner/**/*.test.ts"],
    environment: "node",
    // Security settings load the real shared vault and cryptographic graph.
    testTimeout: 20_000,
  },
});
