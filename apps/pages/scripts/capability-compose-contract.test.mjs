import assert from "node:assert/strict";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  FIXTURE_FACTS,
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { describe, test } from "vitest";
import {
  DISTRIBUTION_BASE_PATH,
  MODULE_OWNERSHIP,
} from "../src/lib/capabilities/ownership.js";
import {
  WORKER_VARIANTS,
  normalizeModuleOwnership,
} from "./lib/capability-distribution.mjs";

// The distribution a real build hands the runtime lists only page-loadable
// modules: a worker unit gets no entry and never reaches `moduleIds`
// (capability-compose-state.mjs resolveModuleTable → buildContract). The
// resolver must still distribute a capability whose worker unit a variant
// carries. `distributionFromOwnership` lists every owned id, worker units
// included, so tests resolving against it could not see the difference.
function buildEmittedContract() {
  const records = normalizeModuleOwnership(
    MODULE_OWNERSHIP,
    CAPABILITY_CATALOG,
  );
  return {
    distributionId: "emitted",
    mode: "selective",
    capabilityIds: CAPABILITY_CATALOG.capabilities.map((d) => d.id),
    moduleIds: records
      .filter((record) => record.entry !== null)
      .map((record) => record.id)
      .sort(),
    workerVariants: WORKER_VARIANTS.map(({ id, scriptPath, satisfies }) => ({
      id,
      scriptPath,
      satisfies: [...satisfies],
    })),
    basePath: DISTRIBUTION_BASE_PATH,
  };
}

describe("the contract a build emits", () => {
  test("leaves worker units out, and push notifications still resolve", () => {
    const distribution = buildEmittedContract();
    assert.ok(
      distribution.moduleIds.includes("notifications.web-push/runtime"),
    );
    assert.ok(
      !distribution.moduleIds.includes("notifications.web-push/worker"),
    );
    const input = fixtureResolveInput({
      catalog: CAPABILITY_CATALOG,
      distribution,
      installation: fixtureSelection({
        instanceId: "personal-local",
        basePolicyRevision: null,
        acceptedRequired: [],
        selectedOptional: ["notifications.web-push"],
      }),
      facts: FIXTURE_FACTS,
    });
    const receipt = buildConsentReceipt(
      resolveComposition(input),
      CAPABILITY_CATALOG,
      FIXTURE_FACTS.now,
    );
    const plan = resolveComposition({ ...input, receipt });
    const push = plan.capabilities["notifications.web-push"];
    assert.equal(push?.distributed, true);
    assert.deepEqual(push?.reasons, []);
    assert.equal(push?.approved, true);
    assert.equal(plan.requiredWorkerVariant, "push");
  });
});
