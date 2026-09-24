import { defineConfig } from "vitest/config";

// Oxlint's RuleTester binds to the global describe/it when they exist, so the
// suites need Vitest globals; without them each tester.run would execute
// outside any registered test.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["rules/**/*.test.ts", "effect/rules/**/*.test.ts"],
    // A case that resolves an imported type reads and parses the fixture
    // file it names: 1-2.5s each on CI, and the first one also pays oxlint's
    // plugin load. Vitest's 5s default failed one at 5051ms on a loaded
    // runner (`no-unsafe-dictionary-type`), which is a budget, not a bug.
    testTimeout: 30_000,
  },
});
