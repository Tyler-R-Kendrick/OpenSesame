import { describe, expect, it } from "vitest";
import { FEATURES, isSwitchable } from "../../lib/capabilities/features.js";
import { INTEGRATIONS } from "../../lib/capabilities/integrations.js";
import { CAPABILITY_TUTORIALS } from "./capability-tutorials.js";
import { FEATURE_GOALS, FEATURE_TUTORIALS } from "./feature-goals.js";
import {
  INTEGRATION_GOALS,
  INTEGRATION_TUTORIALS,
} from "./integration-goals.js";

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

describe("integration tours", () => {
  for (const integration of INTEGRATIONS) {
    const goalId = INTEGRATION_TUTORIALS[integration.id];
    const goal = INTEGRATION_GOALS.find((entry) => entry.id === goalId);
    if (!goal) continue;

    it(`${integration.id}: connects by reference and promises no switch`, () => {
      // A third party is configured on its own page, so an integration has no
      // switch; the switch is the feature's, on Settings › Features.
      expect(claimsASwitch(goal.title), goal.title).toBe(false);
      expect(claimsASwitch(goal.guide), goal.guide).toBe(false);
    });
  }

  it("keeps provider tours out of the feature list, and switch tours out of this one", () => {
    expect(FEATURE_GOALS.every((goal) => goal.id.startsWith("feature."))).toBe(
      true,
    );
    expect(
      INTEGRATION_GOALS.every((goal) => goal.id.startsWith("integration.")),
    ).toBe(true);
    const featureIds = new Set(FEATURES.map((feature) => String(feature.id)));
    for (const retired of [
      "encryption",
      "backups",
      "password-managers",
      "cloud-secret-storage",
      "local-storage",
    ]) {
      expect(featureIds.has(retired), retired).toBe(false);
      expect(
        FEATURE_GOALS.some((goal) => goal.id === `feature.${retired}`),
        retired,
      ).toBe(false);
    }
  });
});
