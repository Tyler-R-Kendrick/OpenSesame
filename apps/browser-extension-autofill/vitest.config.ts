import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Match WXT's @ alias so tests import the actual registered entrypoint.
// Unit tests sit beside the logic in lib/. The node:test pacts under tests/
// run under their own runner.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
