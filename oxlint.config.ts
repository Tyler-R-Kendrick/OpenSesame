import { defineConfig } from "oxlint";

export default defineConfig({
  // `pnpm lint:anti-slop` is the anti-slop gate. Built-in Oxlint categories
  // stay off here; Biome remains the repo's general lint.
  categories: {
    correctness: "off",
    suspicious: "off",
    pedantic: "off",
    perf: "off",
    style: "off",
    restriction: "off",
    nursery: "off",
  },
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".deepsec/**",
    ".gemini/**",
    ".impeccable/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".serena/**",
    ".superpowers/**",
    ".tools/**",
    ".windsurf/**",
    "**/dist/**",
    "**/dev-dist/**",
    "**/node_modules/**",
    "**/target/**",
    "coverage/**",
    "artifacts/**",
    "sbom/**",
    // The plugin and its installer mirror contain the syntax they diagnose.
    // `pnpm test:anti-slop` validates both implementations and exact parity.
    "skills/install-anti-slop/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
