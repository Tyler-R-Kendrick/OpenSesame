import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // The same headroom, for the hook that actually does the slow work.
    //
    // Nine suites boot a WASM Postgres and apply every drizzle migration in a
    // `beforeAll` (`tests/pg-harness-full.ts`). That is seconds of work by
    // design, and it gets slower with each migration added — 22 at the time of
    // writing. `testTimeout` was raised for exactly this cost, but a hook does
    // not inherit it, so the boot kept vitest's 10s default and CI failed:
    //
    //     FAIL tests/consent-store.test.ts > createPostgresConsentStore
    //     Error: Hook timed out in 10000ms.
    //
    // In that same run `postgres-client-origin-store.test.ts` took 8493ms — a
    // 15% margin under `--maxWorkers=4` contention, which is a coin flip
    // rather than a limit. Locally, unloaded, the boot is well under 2s.
    hookTimeout: 30_000,
  },
});
