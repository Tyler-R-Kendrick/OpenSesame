import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/tests/**/*.test.ts",
    ],
    exclude: ["apps/eve-deepsec/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
