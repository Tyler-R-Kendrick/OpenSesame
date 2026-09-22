import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { digestCanonical, fnv1a64Hex } from "./digest.js";
import { resolveEffectivePlan } from "./resolver.js";
import {
  descriptor,
  distribution,
  policy,
  selection,
  vaultRestriction,
} from "./test-helpers.js";

/** Build a small multi-branch plan whose shape is the compatibility contract. */
function buildPlan(): string {
  const outcome = resolveEffectivePlan({
    distribution: distribution([
      descriptor("core.fill", { operationIds: ["fill.into-field"] }),
      descriptor("core.share", {
        dependencies: ["core.fill"],
        declaredPrivileges: {
          egressOrigins: ["https://share.example"],
          keyAccess: { vaultRead: true, vaultWrite: false, deviceKeys: false },
          browserPermissions: [],
        },
      }),
      descriptor("core.audit", { environments: ["service-worker"] }),
    ]),
    instancePolicy: policy({
      required: ["core.fill", "core.share"],
      optional: ["core.audit"],
      prohibited: ["legacy.plain"],
    }),
    vaultRestriction: vaultRestriction({
      allow: { ids: ["core.fill", "core.audit"] },
    }),
    installationSelection: selection({ required: ["core.fill"] }),
    runtimeEnvironments: ["document"],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    consentedCapabilityIds: [],
  });
  if (!outcome.ok) throw new Error("fixture plan must resolve");
  const digest = digestCanonical(outcome.plan);
  if (digest === undefined) throw new Error("fixture plan must digest");
  const lines = [
    "# capability-composition plan — approved behaviour",
    "",
    `planDigest: ${outcome.plan.planIdentity.planDigest}`,
    `canonicalDigest: ${digest}`,
    "",
    ...outcome.plan.selected.map((c) => {
      const axes = Object.entries(c.stateAxes)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",");
      return `- ${c.id} [${c.activationStatus}] axes={${axes}} reasons=[${c.reasonCodes.join(",")}]`;
    }),
    ...outcome.plan.conflicts.map(
      (c) =>
        `! ${c.capabilityId} ${c.reasonCode} (${c.provenance}): ${c.detail}`,
    ),
    ...outcome.plan.consentDeltas.map(
      (d) =>
        `? consent ${d.capabilityId} required=${d.required} granted=${d.granted}`,
    ),
    "",
  ];
  return `${lines.join("\n")}`;
}

describe("plan approval (Verify equivalent)", () => {
  it("matches the approved plan rendering", async () => {
    await expect(buildPlan()).toMatchFileSnapshot(
      "./__snapshots__/plan.approved.md",
    );
  });

  it("pins the digest primitive to the FNV-1a 64 vector", () => {
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
  });
});
