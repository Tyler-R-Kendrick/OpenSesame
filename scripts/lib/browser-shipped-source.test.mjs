import assert from "node:assert/strict";
import { test } from "node:test";
import { isShippedBrowserSource } from "./browser-shipped-source.mjs";

test("browser source inspection excludes Node-only test support by the shared boundary", () => {
  for (const path of [
    "src/lib/native-s3-backup.test-support.ts",
    "src/lib/secret-fs/s3-response.test-support.ts",
    "src/lib/provider.test.ts",
    "src/ui/provider.test.tsx",
    "src/lib/provider.spec.mjs",
    "src/lib/__tests__/provider.ts",
    "src/lib/test/provider.ts",
    "src/node/provider.ts",
  ])
    assert.equal(isShippedBrowserSource(path), false, path);
});

test("ordinary browser adapters remain inspected even beside test and Node modules", () => {
  for (const path of [
    "src/lib/native-s3-backup.ts",
    "src/lib/secret-fs/s3-response.ts",
    "src/lib/native-response-json.ts",
    "src/browser/native-transport.ts",
    "src/lib/node-adapter.ts",
    "src/lib/latest/provider.ts",
  ])
    assert.equal(isShippedBrowserSource(path), true, path);
});
