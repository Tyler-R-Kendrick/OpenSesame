import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForModelProviderSheetKeyField } from "./native-browser-catalog-sheet-contract.mjs";

test("waitForModelProviderSheetKeyField is a function", () => {
  assert.equal(typeof waitForModelProviderSheetKeyField, "function");
});
