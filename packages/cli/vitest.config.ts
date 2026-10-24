import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Several command tests spawn real helper processes; a loaded 4-way
    // workspace run can exceed Vitest's 5s default without a code failure.
    testTimeout: 15_000,
  },
});
