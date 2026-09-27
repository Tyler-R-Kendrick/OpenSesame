import { describe, expect, it } from "vitest";
import { parseCanaryActivation, recordCanaryHit } from "./canary/detect.js";
import { refuseUnsupportedDuressFormat } from "./feature/format.js";
import { resolveDuressMode } from "./feature/mode.js";

describe("canary + feature", () => {
  it("rejects destructive injection and refuses unsupported formats", () => {
    expect(() =>
      parseCanaryActivation({
        version: 1,
        canaryId: "c",
        routeRef: "r",
        wipe: true,
      }),
    ).toThrow(/destructive/);
    const hit = recordCanaryHit({
      canaryId: "c1",
      detectedAt: new Date().toISOString(),
    });
    expect(hit.kind).toBe("detection_only");
    expect(resolveDuressMode({})).toBe("off");
    expect(
      refuseUnsupportedDuressFormat({ duressFormatVersion: 9, armed: true }, 1),
    ).toEqual({ ok: false, code: "unsupported_profile_version" });
  });
});
