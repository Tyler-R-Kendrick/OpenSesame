import { describe, expect, it } from "vitest";
import {
  canaryFalsePositiveBound,
  executeCanary,
  resetCanaryStateForTests,
  revokeCanaryRoute,
} from "./canary/detect.js";

describe("canary executor ceiling", () => {
  it("rejects destructive params, dedups, and honors revoke", () => {
    resetCanaryStateForTests();
    const id = "canary-honeytoken-1";
    expect(
      executeCanary({
        event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
        enrolledRouteRefs: ["route-alert-1"],
        action: "wipe",
      }).ok,
    ).toBe(false);
    expect(
      executeCanary({
        event: {
          version: 1,
          canaryId: id,
          routeRef: "route-alert-1",
          wipe: true,
        },
        enrolledRouteRefs: ["route-alert-1"],
      }).ok,
    ).toBe(false);
    const a = executeCanary({
      event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(a).toMatchObject({ ok: true });
    if (!a.ok) throw new Error(`expected ok, got ${JSON.stringify(a)}`);
    expect(a.result.kind).toBe("detection_only");
    expect(a.result.notified).toBe(true);
    const b = executeCanary({
      event: { version: 1, canaryId: id, routeRef: "route-alert-1" },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(b).toMatchObject({ ok: true });
    if (!b.ok) throw new Error("expected ok");
    expect(b.result.deduped).toBe(true);
    const bound = canaryFalsePositiveBound([a.result, b.result]);
    expect(bound.notifications).toBe(1);
    revokeCanaryRoute("route-alert-1");
    const revoked = executeCanary({
      event: {
        version: 1,
        canaryId: "canary-honeytoken-2",
        routeRef: "route-alert-1",
      },
      enrolledRouteRefs: ["route-alert-1"],
    });
    expect(revoked).toMatchObject({ ok: true });
    if (!revoked.ok) throw new Error("expected ok");
    expect(revoked.result.notified).toBe(false);
  });
});
