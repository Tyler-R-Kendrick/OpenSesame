import { afterEach, describe, expect, it } from "vitest";
import { AlertOutbox } from "../alert/outbox.js";
import { importAlertSealingKey } from "../alert/seal.js";
import {
  CANARY_BOUNDS,
  CANARY_CAPABILITY_CEILING,
  CanaryRegistry,
  canaryFalsePositiveBound,
  enrollHoneytokenCanary,
  executeCanary,
  executeCanaryDetection,
  parseCanaryActivation,
  parseCanaryEnrollment,
  recordCanaryHit,
  refuseDestructiveCanaryAction,
  resetCanaryStateForTests,
  revokeCanaryRoute,
} from "./detect.js";

const FP = "fp-honeytoken-deadbeef01";

async function alertMaterial() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return importAlertSealingKey(raw);
}

afterEach(() => {
  resetCanaryStateForTests();
});

describe("CANARY-A honeytoken enrollment", () => {
  it("enrolls detection-only honeytoken with optional receiver", () => {
    const enrolled = enrollHoneytokenCanary({
      canaryId: "canary-ht-1",
      tokenFingerprint: FP,
      receiver: {
        routeRef: "route-alert-1",
        templateRef: "tpl-canary",
        maxRetries: 2,
        expiryMs: 60_000,
        retainOutboxAcrossRemoval: false,
      },
    });
    expect(enrolled.kind).toBe("honeytoken_open");
    expect(enrolled.receiver?.routeRef).toBe("route-alert-1");
    expect(CANARY_CAPABILITY_CEILING).toContain("detect");
    const ceiling: readonly string[] = CANARY_CAPABILITY_CEILING;
    expect(ceiling.includes("removal")).toBe(false);
  });

  it("allows enrollment without receiver (local detection only)", () => {
    const reg = new CanaryRegistry();
    const enrolled = reg.enrollHoneytoken({
      canaryId: "canary-local",
      tokenFingerprint: FP,
    });
    expect(enrolled.receiver).toBeNull();
  });

  it("rejects unknown canary kinds at schema", () => {
    expect(() =>
      parseCanaryEnrollment({
        version: 1,
        canaryId: "canary-x",
        kind: "destructive_wipe",
        tokenFingerprint: FP,
        receiver: null,
      }),
    ).toThrow(/unsupported canary kind/);
  });
});

describe("CANARY-B schema+executor capability ceiling", () => {
  it("schema rejects destructive injection on activation", () => {
    expect(() =>
      parseCanaryActivation({
        version: 1,
        canaryId: "c",
        routeRef: "r",
        wipe: true,
      }),
    ).toThrow(/destructive/);
    expect(() =>
      parseCanaryEnrollment({
        version: 1,
        canaryId: "canary-bad",
        kind: "honeytoken_open",
        tokenFingerprint: FP,
        receiver: null,
        removal: { kind: "local_enumerated" },
      }),
    ).toThrow(/removal/);
  });

  it("executor refuses destructive action bags and params", () => {
    expect(refuseDestructiveCanaryAction({ wipe: true })).toMatchObject({
      ok: false,
      code: "contradictory_actions",
    });
    expect(
      executeCanary({
        event: { version: 1, canaryId: "c", routeRef: "route-alert-1" },
        enrolledRouteRefs: ["route-alert-1"],
        action: "wipe",
      }),
    ).toEqual({ ok: false, code: "contradictory_actions" });
    expect(
      executeCanary({
        event: { version: 1, canaryId: "c", routeRef: "route-alert-1" },
        enrolledRouteRefs: ["route-alert-1"],
        params: { removal: true },
      }),
    ).toEqual({ ok: false, code: "contradictory_actions" });
  });

  it("executor rejects nested destructive injection on activation", async () => {
    const reg = new CanaryRegistry();
    const enrolled = reg.enrollHoneytoken({
      canaryId: "canary-inj",
      tokenFingerprint: FP,
    });
    const out = await executeCanaryDetection({
      enrollment: enrolled,
      activation: {
        version: 1,
        canaryId: "canary-inj",
        kind: "honeytoken_open",
        tokenFingerprint: FP,
        mintSession: true,
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("contradictory_actions");
  });
});

describe("CANARY-C dedup", () => {
  it("dedups repeated hits within the window", () => {
    const a = recordCanaryHit({ canaryId: "c-dedup" });
    const b = recordCanaryHit({ canaryId: "c-dedup" });
    expect(a.kind).toBe("detection_only");
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(canaryFalsePositiveBound([a, b])).toEqual({
      detections: 2,
      notifications: 1,
    });
  });
});

describe("CANARY-D false-positive bounds", () => {
  it("suppresses alerts after false-positive max hits", async () => {
    const reg = new CanaryRegistry();
    const enrolled = reg.enrollHoneytoken({
      canaryId: "canary-fp",
      tokenFingerprint: FP,
      receiver: {
        routeRef: "route-alert-1",
        templateRef: "tpl-canary",
        maxRetries: 1,
        expiryMs: 60_000,
        retainOutboxAcrossRemoval: false,
      },
    });
    const key = await alertMaterial();
    const box = new AlertOutbox();
    const base = Date.now();

    let last: Awaited<ReturnType<typeof executeCanaryDetection>> | undefined;
    for (let i = 0; i < CANARY_BOUNDS.falsePositiveMaxHits + 2; i++) {
      last = await executeCanaryDetection({
        enrollment: enrolled,
        activation: {
          version: 1,
          canaryId: "canary-fp",
          kind: "honeytoken_open",
          tokenFingerprint: FP,
          detectedAt: new Date(
            base + i * (CANARY_BOUNDS.dedupWindowMs + 1),
          ).toISOString(),
        },
        outbox: box,
        sealingKey: key,
        now: base + i * (CANARY_BOUNDS.dedupWindowMs + 1),
      });
      expect(last.ok).toBe(true);
    }
    expect(last?.ok && last.result.alertSuppressed).toBe(true);
    expect(box.list().length).toBe(CANARY_BOUNDS.falsePositiveMaxHits);
  });

  it("rejects short fingerprints at enrollment (false-positive bound)", () => {
    expect(() =>
      parseCanaryEnrollment({
        version: 1,
        canaryId: "canary-short",
        kind: "honeytoken_open",
        tokenFingerprint: "too-short",
        receiver: null,
      }),
    ).toThrow(/tokenFingerprint|invalid/);
  });
});

describe("CANARY-E revoke route", () => {
  it("revokes route so detection continues without alerts", async () => {
    const reg = new CanaryRegistry();
    reg.enrollHoneytoken({
      canaryId: "canary-rev",
      tokenFingerprint: FP,
      receiver: {
        routeRef: "route-alert-1",
        templateRef: "tpl-canary",
        maxRetries: 1,
        expiryMs: 60_000,
        retainOutboxAcrossRemoval: false,
      },
    });
    const revoked = reg.revokeRoute("canary-rev");
    expect(revoked.routeRevoked).toBe(true);

    const key = await alertMaterial();
    const box = new AlertOutbox();
    const out = await executeCanaryDetection({
      enrollment: revoked,
      activation: {
        version: 1,
        canaryId: "canary-rev",
        kind: "honeytoken_open",
        tokenFingerprint: FP,
      },
      outbox: box,
      sealingKey: key,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.kind).toBe("detection_only");
      expect(out.result.matched).toBe(true);
      expect(out.result.alertQueued).toBe(false);
    }
    expect(box.list()).toHaveLength(0);

    revokeCanaryRoute("route-alert-1");
    expect(
      executeCanary({
        event: { version: 1, canaryId: "x", routeRef: "route-alert-1" },
        enrolledRouteRefs: ["route-alert-1"],
      }).ok,
    ).toBe(true);
  });
});

describe("CANARY-F injection + matched alert path", () => {
  it("queues value-blind alert on matched honeytoken (no production authority)", async () => {
    const reg = new CanaryRegistry();
    const enrolled = reg.enrollHoneytoken({
      canaryId: "canary-ok",
      tokenFingerprint: FP,
      receiver: {
        routeRef: "route-alert-1",
        templateRef: "tpl-canary",
        maxRetries: 2,
        expiryMs: 120_000,
        retainOutboxAcrossRemoval: false,
      },
    });
    const key = await alertMaterial();
    const box = new AlertOutbox();
    const out = await executeCanaryDetection({
      enrollment: enrolled,
      activation: {
        version: 1,
        canaryId: "canary-ok",
        kind: "honeytoken_open",
        tokenFingerprint: FP,
      },
      outbox: box,
      sealingKey: key,
      incidentId: "inc-canary-1",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result).toMatchObject({
        kind: "detection_only",
        matched: true,
        alertQueued: true,
        deduped: false,
      });
    }
    expect(box.list()).toHaveLength(1);
    expect(box.list()[0]?.pkg.routeRef).toBe("route-alert-1");
  });

  it("does not match wrong fingerprint (no false positive alert)", async () => {
    const reg = new CanaryRegistry();
    const enrolled = reg.enrollHoneytoken({
      canaryId: "canary-nomatch",
      tokenFingerprint: FP,
      receiver: {
        routeRef: "route-alert-1",
        templateRef: "tpl-canary",
        maxRetries: 1,
        expiryMs: 60_000,
        retainOutboxAcrossRemoval: false,
      },
    });
    const key = await alertMaterial();
    const box = new AlertOutbox();
    const out = await executeCanaryDetection({
      enrollment: enrolled,
      activation: {
        version: 1,
        canaryId: "canary-nomatch",
        kind: "honeytoken_open",
        tokenFingerprint: "fp-honeytoken-wrongwrong01",
      },
      outbox: box,
      sealingKey: key,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.matched).toBe(false);
      expect(out.result.alertQueued).toBe(false);
    }
    expect(box.list()).toHaveLength(0);
  });

  it("rejects unapproved route at executor", () => {
    expect(
      executeCanary({
        event: { version: 1, canaryId: "c", routeRef: "route-other" },
        enrolledRouteRefs: ["route-alert-1"],
      }),
    ).toEqual({ ok: false, code: "unapproved_route" });
  });
});
