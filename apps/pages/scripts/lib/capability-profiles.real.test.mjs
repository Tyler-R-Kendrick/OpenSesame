import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { describe, test } from "vitest";
import { distributedCapabilities } from "./capability-profile.mjs";

// Every checked-in profile against the real catalog, in both build modes.
// `build:profile --all` found `rich-explicit` invalid after `sharing.drops`
// became always-on, because the fixtures' catalog still lists it optional.

const profilesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "capability-profiles",
);

const profiles = readdirSync(profilesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(profilesDir, name), "utf8")))
  .filter((profile) => profile.expectInvalid !== true);

describe("checked-in capability profiles", () => {
  test("there are profiles to check", () => {
    assert.ok(profiles.length >= 5);
  });
  for (const profile of profiles) {
    for (const mode of ["selective", "hardened"]) {
      test(`${profile.name} validates against the catalog (${mode})`, () => {
        const sets = distributedCapabilities(CAPABILITY_CATALOG, profile, mode);
        assert.ok(sets.distributed.size > 0);
      });
    }
  }
});
