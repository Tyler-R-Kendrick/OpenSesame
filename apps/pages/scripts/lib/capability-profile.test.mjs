import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { CATALOG, policy, selection } from "./capability-fixtures.mjs";
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
});
