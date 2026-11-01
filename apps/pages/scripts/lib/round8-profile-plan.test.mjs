import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  P8_1_AFTER,
  P8_1_BEFORE,
  REPO,
  selectedFeatures,
  shasFor,
} from "./round8-profile-plan.mjs";

test("both galleries are the default plan", () => {
  assert.deepEqual(selectedFeatures(undefined), ["p8-1", "p8-2"]);
  assert.deepEqual(selectedFeatures(""), ["p8-1", "p8-2"]);
});

test("ROUND8_ONLY selects one gallery", () => {
  assert.deepEqual(selectedFeatures("p8-1"), ["p8-1"]);
  assert.deepEqual(selectedFeatures("p8-2"), ["p8-2"]);
});

test("an unknown ROUND8_ONLY is refused", () => {
  assert.throws(
    () => selectedFeatures("p8-3"),
    /ROUND8_ONLY must be p8-1 or p8-2/,
  );
});

test("p8-1 builds the before and after trees", () => {
  assert.deepEqual(shasFor(["p8-1"], "tip-sha"), [P8_1_BEFORE, P8_1_AFTER]);
});

test("p8-2 reuses the p8-1 after build as its before", () => {
  assert.deepEqual(shasFor(["p8-2"], "tip-sha"), [P8_1_AFTER, "tip-sha"]);
});

test("both galleries dedupe the shared middle build", () => {
  assert.deepEqual(shasFor(["p8-1", "p8-2"], "tip-sha"), [
    P8_1_BEFORE,
    P8_1_AFTER,
    "tip-sha",
  ]);
});

test("a tip equal to the p8-1 after build is not listed twice", () => {
  assert.deepEqual(shasFor(["p8-2"], P8_1_AFTER), [P8_1_AFTER]);
});

test("REPO is the repository root", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "opensesame");
  assert.equal(manifest.private, true);
});
