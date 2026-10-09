import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    include: ["e2e/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
