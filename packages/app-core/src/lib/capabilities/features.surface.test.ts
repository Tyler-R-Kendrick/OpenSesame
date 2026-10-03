import { describe, expect, it } from "vitest";
import { optionalCapabilityIds } from "./catalog.js";
import {
  type Feature,
  NO_SURFACE,
  featureById,
  featureOf,
  isSwitchable,
  shown,
} from "./features.js";

describe("capabilities with no Pages code behind them", () => {
  it("are optional, stay in FEATURES for a policy to name, and give no section a switch", () => {
    const optional = new Set(optionalCapabilityIds());
    for (const id of NO_SURFACE) {
      expect(optional.has(id), id).toBe(true);
      const feature = featureOf(id);
      expect(feature, id).not.toBeNull();
      expect(shown(feature as Feature).capabilities).not.toContain(id);
    }
    expect(isSwitchable(featureById("telemetry"))).toBe(false);
    expect(isSwitchable(featureById("certificates"))).toBe(false);
    expect(isSwitchable(featureById("sharing"))).toBe(true);
  });

  it("leave a section's other capabilities alone", () => {
    expect(shown(featureById("identity")).capabilities).toEqual(
      featureById("identity").capabilities,
    );
  });
});
