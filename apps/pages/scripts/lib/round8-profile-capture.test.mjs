import assert from "node:assert/strict";
import { test } from "vitest";
import { textCounts } from "./round8-profile-capture.mjs";

test("textCounts counts each phrase separately", () => {
  const text = [
    "Any browser with the link",
    "This browser",
    "Only this browser can open this drop",
    "Any browser with the link",
  ].join(" ");
  assert.deepEqual(textCounts(text), { any: 2, here: 1, warning: 1 });
});

test("textCounts of an empty region is all zero", () => {
  assert.deepEqual(textCounts(""), { any: 0, here: 0, warning: 0 });
});
