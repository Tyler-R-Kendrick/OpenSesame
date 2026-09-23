import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const osDomain = (path: string) =>
  fileURLToPath(new URL(`../os-domain/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // The browser entry the Pages build resolves, as in app-core.
    alias: { "@opensesame/os-domain": osDomain("browser.ts") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
