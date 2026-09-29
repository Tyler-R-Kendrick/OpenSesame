import { defineConfig } from "vitest/config";

// Unit tests sit beside the logic in lib/. The node:test pacts under tests/
// run under their own runner.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
