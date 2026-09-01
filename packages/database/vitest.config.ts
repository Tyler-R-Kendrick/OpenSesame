import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    /*
     * The same budget as a test, because the hook does strictly more work than
     * the tests it sets up.
     *
     * Eleven files call `createPgTestContext`, and each one boots an in-process
     * Postgres in `beforeAll` and applies every migration in `drizzle/`. That
     * cost grows with the migration count and with how many suites the runner
     * starts at once, while Vitest's default `hookTimeout` stays at 10s — so
     * the expensive half of the file had the tighter deadline, and the margin
     * shrinks every time the schema gains a migration. Under a full
     * `pnpm test`, with every workspace suite running concurrently, that is
     * where it ran out.
     *
     * Raising it removes a deadline that was measuring machine load rather
     * than correctness. A hook that genuinely hangs still fails, at 30s.
     */
    hookTimeout: 30_000,
  },
});
