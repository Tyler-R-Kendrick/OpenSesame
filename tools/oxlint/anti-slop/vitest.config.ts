import { defineConfig } from "vitest/config";

// Oxlint's RuleTester binds to the global describe/it when they exist, so the
// suites need Vitest globals; without them each tester.run would execute
// outside any registered test.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["rules/**/*.test.ts", "effect/rules/**/*.test.ts"],
  },
});
