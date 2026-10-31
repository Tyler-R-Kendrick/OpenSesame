import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("classifies only the named cross-feature cipher compatibility test", () => {
  expect(classify("src/lib/noble-v1-compat.test.ts")).toMatchObject({
    pattern: "src/lib/noble-v1-compat.test.ts",
    classification: "shared",
    capability: null,
  });
  expect(classify("src/lib/noble-v1-compat.ts")).toBeNull();
  expect(classify("src/lib/noble-v1-compat-extra.test.ts")).toBeNull();
});
