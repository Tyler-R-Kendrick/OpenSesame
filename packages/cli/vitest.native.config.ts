import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/native-vault.native-controls.ts"],
    testTimeout: 30000,
  },
});
