import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const osDomain = (path: string) =>
  fileURLToPath(new URL(`../os-domain/src/${path}`, import.meta.url));

export default defineConfig({
  define: { "process.env.NODE_DEBUG_NATIVE": "false" },
  resolve: {
    // The same browser entry points the Pages build resolves, so the core is
    // tested against the modules it ships with. Subpaths precede the bare
    // package alias.
    alias: {
      "@opensesame/os-domain/authority-templates": osDomain(
        "authority-templates/index.ts",
      ),
      "@opensesame/os-domain/wallet": osDomain("wallet/index.ts"),
      "@opensesame/os-domain": osDomain("browser.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./src/test-setup.ts"],
  },
});
