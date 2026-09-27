import { describe, expect, it } from "vitest";
import { refuseUnsupportedDuressFormat } from "./feature/format.js";
import {
  compareFeatureModes,
  enrollmentAssetReadiness,
  registerDuressFeature,
  resolveDuressMode,
} from "./feature/mode.js";

describe("feature registration", () => {
  it("off mode fetches no UI/adapters; enrollment readiness fails closed", () => {
    const off = registerDuressFeature(resolveDuressMode({}));
    expect(off.uiSurfaces).toEqual([]);
    expect(off.networkAllowed).toBe(false);
    expect(compareFeatureModes().off.fetchesDuressUi).toBe(false);
    expect(
      enrollmentAssetReadiness({
        modulesCached: false,
        durableStorage: true,
        offlineBootOk: true,
        swMismatch: false,
      }).ok,
    ).toBe(false);
    expect(registerDuressFeature("local_only").adapters.includes("peer")).toBe(
      false,
    );
    expect(
      refuseUnsupportedDuressFormat({ duressFormatVersion: 9, armed: true }, 1),
    ).toEqual({ ok: false, code: "unsupported_profile_version" });
  });
});
