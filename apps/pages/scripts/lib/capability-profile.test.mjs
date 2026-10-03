import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CATALOG,
  descriptor,
  policy,
  selection,
} from "./capability-fixtures.mjs";
import { distributedCapabilities } from "./capability-profile.mjs";

// Profile → distributed-capability set: what a build must carry, per mode.

describe("distributedCapabilities", () => {
  test("personal-local (null policy) permits every optional root; hardened keeps core + closure", () => {
    const sets = distributedCapabilities(
      CATALOG,
      {
        name: "p",
        instancePolicy: null,
        installationSelection: selection([], ["connectors.external"]),
      },
      "hardened",
    );
    assert.deepEqual([...sets.distributed].sort(), [
      "connectors.external",
      "vault.passwords",
    ]);
    assert.deepEqual([...sets.core], ["vault.passwords"]);
  });
  test("selective always distributes the whole catalog but still validates", () => {
    const sets = distributedCapabilities(
      CATALOG,
      { name: "p", instancePolicy: null, installationSelection: null },
      "selective",
    );
    assert.equal(sets.distributed.size, CATALOG.capabilities.length);
    assert.throws(
      () =>
        distributedCapabilities(
          CATALOG,
          {
            name: "p",
            instancePolicy: policy(["nope"], []),
            installationSelection: null,
          },
          "selective",
        ),
      /unknown capability "nope"/,
    );
  });
  test("an alternative that is always-on is carried by every build, not refused as not permitted", () => {
    // `sharing.drops` is core (always on): a profile that still names it as
    // the household transport must validate like a core dependency does, and
    // add nothing to the optional closure.
    const catalog = {
      ...CATALOG,
      capabilities: CATALOG.capabilities.map((entry) =>
        entry.id === "sharing.drops" ? descriptor(entry.id, "core") : entry,
      ),
    };
    const sets = distributedCapabilities(
      catalog,
      {
        name: "p",
        instancePolicy: null,
        installationSelection: selection([], ["sharing.household"], {
          transport: "sharing.drops",
        }),
      },
      "hardened",
    );
    assert.ok(sets.closure.has("sharing.household"));
    assert.ok(!sets.closure.has("sharing.drops"));
    assert.ok(sets.distributed.has("sharing.drops"));
  });
  test("an optional alternative outside the policy is still refused", () => {
    assert.throws(
      () =>
        distributedCapabilities(
          CATALOG,
          {
            name: "p",
            instancePolicy: policy([], ["sharing.household"]),
            installationSelection: selection([], ["sharing.household"], {
              transport: "sharing.drops",
            }),
          },
          "hardened",
        ),
      /alternative "sharing.drops" for slot "transport" is not permitted/,
    );
  });
});
