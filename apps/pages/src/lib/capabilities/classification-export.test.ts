import { expect, it } from "vitest";
import { classify } from "./classification.js";
it.each([
  "src/sections/vault/ExportKey.tsx",
  "src/sections/vault/ExportKey.menu.tsx",
  "src/sections/vault/ExportKey.test.tsx",
])("owns the encrypted backup component %s with its Export key", (path) => {
  expect(classify(path)).toMatchObject({
    classification: "core",
    capability: "backup.local-encrypted",
  });
});
