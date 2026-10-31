import { statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("owns the actual shared UI lock fixture without assigning it to an optional feature", () => {
  const pagesRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = fileURLToPath(
    new URL("../../test-support/lock-manager.ts", import.meta.url),
  );
  expect(statSync(fixture).isFile()).toBe(true);
  const source = relative(pagesRoot, fixture).replaceAll("\\", "/");
  expect(classify(source)).toMatchObject({
    pattern: source,
    classification: "shared",
    capability: null,
  });
});

it.each([
  "src/test-support/lock-manager.tsx",
  "src/test-support/lock-managers.ts",
  "src/test-support/lock-manager-live.ts",
  "src/test-support/other-lock-manager.ts",
  "src/test-support/unowned-fixture.ts",
])("leaves the unrelated test-support module %s unclassified", (source) => {
  expect(classify(source)).toBeNull();
});
