import type { InstanceCapabilityPolicy } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { withoutPresetResidue } from "./preset-residue.js";
import { initialState, readPolicy } from "./store-docs.js";

function policy(
  prohibited: string[],
  presetProvenance: InstanceCapabilityPolicy["presetProvenance"],
): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "personal-local",
    revision: "1",
    presetProvenance,
    capabilities: { default: "deny", required: [], optional: [], prohibited },
    network: { externalServices: "deny", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

// What main-era Personal wrote: every optional id it did not offer.
const LEGACY = policy(
  ["backup.git-remote", "identity.siop", "telemetry.external"],
  { id: "personal", version: 1 },
);

describe("a version-1 preset's residue (ADR 0142)", () => {
  it("drops the ids that became always on, and keeps the rest", () => {
    expect(withoutPresetResidue(LEGACY).capabilities.prohibited).toEqual([
      "telemetry.external",
    ]);
  });

  it("leaves a hand-written or version-2 policy as written", () => {
    const written = policy(["backup.git-remote"], null);
    const current = policy(["backup.git-remote"], {
      id: "personal",
      version: 2,
    });
    expect(withoutPresetResidue(written)).toBe(written);
    expect(withoutPresetResidue(current)).toBe(current);
  });

  it("is how the store reads a saved local policy", () => {
    const state = initialState();
    readPolicy(
      state,
      {
        status: "absent",
        endpoints: {},
        ambientAuth: undefined,
        capabilityComposition: null,
        diagnostics: [],
      },
      {
        selection: null,
        receipt: null,
        localPolicy: { present: true, policy: LEGACY },
        vaultSelection: null,
        committedGeneration: 0,
        diagnostics: [],
      },
      () => ({ ok: true, diagnostics: [] }),
      () => undefined,
    );
    expect(state.policy?.capabilities.prohibited).toEqual([
      "telemetry.external",
    ]);
  });
});
