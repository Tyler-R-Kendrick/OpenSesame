import { describe, expect, it } from "vitest";
import { FEATURES, isSwitchable } from "../../lib/capabilities/features.js";
import { CAPABILITY_TUTORIALS } from "./capability-tutorials.js";
import { FEATURE_GOALS, FEATURE_TUTORIALS } from "./feature-goals.js";

const PROMISES_A_SWITCH = /\bswitch(?:es)?\b|\bturn on\b/i;

/** What the tour says of a switch, less the sentences that deny one. */
function claimsASwitch(text: string): boolean {
  return PROMISES_A_SWITCH.test(text.replace(/\bno switch\b/gi, ""));
}

describe("feature tours on a default plan", () => {
  for (const feature of FEATURES) {
    const goalId = FEATURE_TUTORIALS[feature.id];
    const goal = FEATURE_GOALS.find((entry) => entry.id === goalId);
    if (!goal) continue;
    const switchable =
      isSwitchable(feature, null, { identityApi: true }) ||
      isSwitchable(feature, null, { identityApi: false });

    it(`${feature.id}: ${switchable ? "may" : "does not"} promise a switch`, () => {
      if (switchable) return;
      expect(claimsASwitch(goal.title), goal.title).toBe(false);
      expect(claimsASwitch(goal.guide), goal.guide).toBe(false);
    });
  }

  it("covers the sections that have no surface of their own", () => {
    const certificates = FEATURES.find((entry) => entry.id === "certificates");
    const telemetry = FEATURES.find((entry) => entry.id === "telemetry");
    if (!certificates || !telemetry) throw new Error("feature missing");
    expect(isSwitchable(certificates)).toBe(false);
    expect(isSwitchable(telemetry)).toBe(false);
  });

  it("sends certs.issue to the vault walkthrough while Pages has no Host issuance surface", () => {
    expect(CAPABILITY_TUTORIALS["certs.issue"]).toBe("vault.item.create");
  });
});
