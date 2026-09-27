/**
 * applyPreset and the slots a preset answers (Preset.defaultAlternatives,
 * carried from #470's preset → plan contract): a preset fills the slots its
 * roots need, replaces whatever a previous preset chose, and never fills one
 * with a choice this plan does not permit.
 */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  presetById,
  presetToInstancePolicy,
} from "@opensesame/app-core/lib/capabilities/presets.js";
import {
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { distributionFromOwnership } from "../../lib/capabilities/ownership.js";
import { EMPTY_DRAFT, applyPreset } from "./CapabilityDraft.js";

const START = { ...EMPTY_DRAFT, road: "customize" } as const;

describe("applyPreset and alternatives slots", () => {
  it("Family answers the transport Household sharing needs", () => {
    expect(applyPreset(START, presetById("family"), null).alternatives).toEqual(
      { transport: "sharing.drops" },
    );
  });

  it("another preset replaces the previous preset's answers", () => {
    const family = applyPreset(START, presetById("family"), null);
    expect(
      applyPreset(family, presetById("personal"), null).alternatives,
    ).toEqual({});
  });

  it("a choice this plan does not permit is left unanswered", () => {
    const family = presetToInstancePolicy(presetById("family"), "i", "r1");
    const policy = {
      ...family,
      capabilities: {
        ...family.capabilities,
        optional: family.capabilities.optional.filter(
          (id) => id !== "sharing.drops",
        ),
        prohibited: [...family.capabilities.prohibited, "sharing.drops"],
      },
    };
    const plan = resolveComposition(
      fixtureResolveInput({
        catalog: CAPABILITY_CATALOG,
        distribution: distributionFromOwnership("selective"),
        instancePolicy: policy,
        provenance: "same-origin-deployment",
      }),
    );
    expect(plan.capabilities["sharing.drops"]?.permitted).toBe(false);
    expect(applyPreset(START, presetById("family"), plan).alternatives).toEqual(
      {},
    );
  });
});
