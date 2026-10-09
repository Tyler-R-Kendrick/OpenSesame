import { describe, expect, it } from "vitest";
import { planWith } from "./__tests__/plan-with.js";
import { CAPABILITY_CATALOG, optionalCapabilityIds } from "./catalog.js";
import {
  NEEDS_IDENTITY_API,
  NO_SURFACE,
  featureById,
  featureOf,
  isSwitchable,
  shown,
  switchFeature,
} from "./features.js";

describe("capabilities with no Pages code behind them", () => {
  it("are optional, stay in FEATURES for a policy to name, and give no section a switch", () => {
    const optional = new Set(optionalCapabilityIds());
    for (const id of NO_SURFACE) {
      expect(optional.has(id), id).toBe(true);
      const feature = featureOf(id);
      if (feature === null) throw new Error(`${id} is not in FEATURES`);
      expect(shown(feature).capabilities).not.toContain(id);
    }
    expect(isSwitchable(featureById("telemetry"))).toBe(false);
    expect(isSwitchable(featureById("certificates"))).toBe(false);
    // Live sessions and org-vault relay keep Sharing switchable. Household
    // sharing does not (NO_SURFACE until a plan names it).
    expect(isSwitchable(featureById("sharing"))).toBe(true);
    expect(shown(featureById("sharing")).capabilities).toEqual([
      "sharing.live",
      "sharing.relay",
    ]);
  });

  it("hides household sharing until a plan approves it, then keeps the switch that turns it off", () => {
    const sharing = featureById("sharing");
    const approved = planWith(["sharing.household"]);
    expect(shown(sharing, approved).capabilities).toEqual([
      "sharing.live",
      "sharing.household",
      "sharing.relay",
    ]);
    expect(isSwitchable(sharing, approved)).toBe(true);
    // The section switch Settings draws is the shown feature, so turning
    // Sharing on does not select a capability with nothing behind it.
    expect(
      switchFeature(
        { roots: [], alternatives: {} },
        shown(sharing),
        true,
        planWith([]),
        CAPABILITY_CATALOG,
      ).roots,
    ).toEqual(["sharing.live", "sharing.relay"]);
  });

  it("leave a section's other capabilities alone", () => {
    expect(shown(featureById("identity")).capabilities).toEqual(
      featureById("identity").capabilities,
    );
  });

  it("keep their one switch while a plan approves them, so what runs on them is never stranded", () => {
    const plan = planWith(["enterprise.ca-administration"]);
    const certificates = featureById("certificates");
    expect(shown(certificates, plan).capabilities).toEqual([
      "enterprise.ca-administration",
    ]);
    expect(isSwitchable(certificates, plan)).toBe(true);
    // Switched off, it is absent again.
    expect(isSwitchable(certificates, planWith([]))).toBe(false);
    expect(isSwitchable(certificates, null)).toBe(false);
  });
});

describe("capabilities whose only road is an Identity API's (ADR 0162)", () => {
  const NONE = { identityApi: false };
  const NAMED = { identityApi: true };

  it("are optional, and are exactly Web Push and Notification routing", () => {
    const optional = new Set(optionalCapabilityIds());
    expect([...NEEDS_IDENTITY_API].sort()).toEqual([
      "notifications.routing",
      "notifications.web-push",
    ]);
    for (const id of NEEDS_IDENTITY_API)
      expect(optional.has(id), id).toBe(true);
  });

  it("are left out of their section with no Identity API named, and the section has no switch", () => {
    const notifications = featureById("notifications");
    expect(shown(notifications, null, NONE).capabilities).toEqual([]);
    expect(isSwitchable(notifications, null, NONE)).toBe(false);
  });

  it("are drawn when one is named, and by default, which withholds nothing", () => {
    const notifications = featureById("notifications");
    expect(shown(notifications, null, NAMED).capabilities).toEqual(
      notifications.capabilities,
    );
    expect(shown(notifications).capabilities).toEqual(
      notifications.capabilities,
    );
    expect(isSwitchable(notifications, null, NAMED)).toBe(true);
  });

  it("keep their switch while the plan approves them, so nothing is stranded", () => {
    const plan = planWith(["notifications.web-push"]);
    expect(
      shown(featureById("notifications"), plan, NONE).capabilities,
    ).toEqual(["notifications.web-push"]);
    expect(isSwitchable(featureById("notifications"), plan, NONE)).toBe(true);
  });

  it("leave every other section alone, and Local notifications its one switch", () => {
    expect(shown(featureById("identity"), null, NONE).capabilities).toEqual(
      featureById("identity").capabilities,
    );
    expect(isSwitchable(featureById("local-notifications"), null, NONE)).toBe(
      true,
    );
  });
});
