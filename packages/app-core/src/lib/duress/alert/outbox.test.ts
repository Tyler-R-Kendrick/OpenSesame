import { describe, expect, it } from "vitest";
import {
  AlertOutbox,
  AlertRouteRegistry,
  assertSafeAlertOrigin,
  createMemoryOutboxStore,
  importAlertSealingKey,
  sealAlertPackage,
  verifyAlertEvidence,
} from "./index.js";

async function sealingMaterial() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return importAlertSealingKey(raw);
}

describe("ALERT sealed package", () => {
  it("seals without protected root and authenticates evidence", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const pkg = await sealAlertPackage({
      incidentId: "inc-1",
      profileId: "prof-alert",
      routeRef: "route-1",
      templateRef: "tmpl-1",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(pkg.schemaVersion).toBe(1);
    expect(pkg.ciphertextB64.length).toBeGreaterThan(16);
    expect(await verifyAlertEvidence(pkg, macKey)).toBe(true);
    const bad = { ...pkg, nonce: "tampered" };
    expect(await verifyAlertEvidence(bad, macKey)).toBe(false);
  });
});

describe("ALERT outbox statuses", () => {
  it("keeps queued ≠ delivered ≠ recipient_received ≠ human_acknowledged", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const pkg = await sealAlertPackage({
      incidentId: "inc-1",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 3);
    expect(box.get(pkg.packageId)?.status).toBe("queued");

    await box.attemptDelivery(pkg.packageId, async () => "accepted", macKey);
    expect(box.get(pkg.packageId)?.status).toBe("delivered");

    expect(() =>
      box.advance(pkg.packageId, "human_acknowledged", "relay"),
    ).toThrow(/authority_mismatch/);

    box.advance(pkg.packageId, "recipient_received", "recipient_device");
    expect(box.get(pkg.packageId)?.status).toBe("recipient_received");

    box.advance(pkg.packageId, "human_acknowledged", "human");
    expect(box.get(pkg.packageId)?.status).toBe("human_acknowledged");
  });

  it("retries, fails after max, and survives restart", async () => {
    const store = createMemoryOutboxStore();
    const { encryptKey, macKey } = await sealingMaterial();
    const pkg = await sealAlertPackage({
      incidentId: "inc-2",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    const box = new AlertOutbox({ store });
    box.enqueue(pkg, 1);
    await box.attemptDelivery(pkg.packageId, async () => "rejected", macKey);
    expect(box.get(pkg.packageId)?.status).toBe("queued");
    await box.attemptDelivery(
      pkg.packageId,
      async () => {
        throw new Error("network");
      },
      macKey,
    );
    expect(box.get(pkg.packageId)?.status).toBe("failed");
    await box.persist();

    const box2 = new AlertOutbox({ store });
    await box2.hydrate();
    expect(box2.get(pkg.packageId)?.status).toBe("failed");
    expect(box2.diagnostics()[0]?.lastError).toBeDefined();
  });

  it("dedupes enqueue and expires overdue queued packages", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const now = Date.now();
    const pkg = await sealAlertPackage({
      incidentId: "inc-3",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 1_000,
      policyRevision: 1,
      keyEpoch: 1,
      now,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 2, now);
    box.enqueue(pkg, 2, now);
    expect(box.list()).toHaveLength(1);
    box.expireOverdue(now + 5_000);
    expect(box.get(pkg.packageId)?.status).toBe("expired");
  });

  it("applies late-delivery cancel without escalating to destruction", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const pkg = await sealAlertPackage({
      incidentId: "inc-4",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    const box = new AlertOutbox({ latePolicy: { kind: "cancel_if_resolved" } });
    box.enqueue(pkg, 2);
    box.markIncidentResolved(true);
    await box.attemptDelivery(pkg.packageId, async () => "accepted", macKey);
    expect(box.get(pkg.packageId)?.status).toBe("cancelled");
    expect(box.exportRetainedOpaque()).toHaveLength(0);
  });

  it("rejects clock-skewed expired packages at delivery", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const issued = Date.now() - 120_000;
    const pkg = await sealAlertPackage({
      incidentId: "inc-5",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
      now: issued,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 2, issued);
    await box.attemptDelivery(
      pkg.packageId,
      async () => "accepted",
      macKey,
      Date.now(),
    );
    expect(box.get(pkg.packageId)?.status).toBe("expired");
  });
});

describe("ALERT route registry", () => {
  it("requires consent+test before ready; revokes cleanly", () => {
    const reg = new AlertRouteRegistry();
    expect(() => assertSafeAlertOrigin("http://evil.example")).toThrow(
      /unapproved_route/,
    );
    expect(() => assertSafeAlertOrigin("https://169.254.169.254/")).toThrow();
    const enrolled = reg.enroll({
      routeRef: "route-ok",
      origin: "https://peer.example/alert",
      recipientPrincipalRef: "user-2",
      templateRef: "tmpl",
      consentedAt: new Date().toISOString(),
    });
    expect(enrolled.readiness).toBe("configured");
    expect(() => reg.assertReady("route-ok")).toThrow(/not verified_ready/);
    reg.markTestPassed("route-ok", new Date().toISOString());
    expect(reg.assertReady("route-ok").readiness).toBe("verified_ready");
    reg.revoke("route-ok", new Date().toISOString());
    expect(() => reg.assertReady("route-ok")).toThrow(/revoked/);
  });
});

describe("ALERT-A protected root + value-blind", () => {
  it("rejects protected-root handles and secret-shaped payload keys", async () => {
    const { rejectProtectedRootForAlert } = await import("./seal.js");
    expect(() =>
      rejectProtectedRootForAlert({
        kind: "protected_root",
        opensProtectedRoot: true,
      }),
    ).toThrow(/protected root/);
    const { encryptKey, macKey } = await sealingMaterial();
    await expect(
      sealAlertPackage({
        incidentId: "inc",
        profileId: "p",
        routeRef: "r",
        templateRef: "t",
        payload: { rootKey: "nope" },
        encryptKey,
        macKey,
        expiryMs: 60_000,
        policyRevision: 1,
        keyEpoch: 1,
      }),
    ).rejects.toThrow(/value-blind/);
  });
});

describe("ALERT-C authenticated status evidence + human claim", () => {
  it("mints verifiable status evidence and rejects bare ack claims", async () => {
    const {
      createAlertEvidenceKey,
      mintStatusEvidence,
      verifyStatusEvidence,
      rejectUnauthenticatedHumanClaim,
    } = await import("./evidence.js");
    const key = await createAlertEvidenceKey();
    const ev = await mintStatusEvidence({
      packageId: "pkg-1",
      incidentId: "inc-1",
      fromStatus: "delivered",
      toStatus: "human_acknowledged",
      authority: "human",
      evidenceKey: key,
    });
    expect(ev.disclaimer).toBe("no_emergency_response_guarantee");
    expect(await verifyStatusEvidence(ev, key)).toBe(true);
    expect(() =>
      rejectUnauthenticatedHumanClaim({ acknowledged: true }),
    ).toThrow(/authority_mismatch/);
    expect(() =>
      rejectUnauthenticatedHumanClaim({
        acknowledged: true,
        authority: "human",
        evidence: ev,
      }),
    ).not.toThrow();
  });
});

describe("ALERT-E/F failure policies, queue delete, duplicates, diagnostics", () => {
  it("decides compromise/failure without destruction escalation", async () => {
    const { decideTransportFailure, decideLateDelivery } = await import(
      "./policy.js"
    );
    const compromised = decideTransportFailure({
      kind: "compromised_device",
      attempts: 1,
      maxRetries: 5,
    });
    expect(compromised.nextStatus).toBe("failed");
    expect(compromised.destructionEscalation).toBe(false);
    expect(compromised.presentationUnchanged).toBe(true);
    const late = decideLateDelivery({ kind: "deliver_anyway" }, true);
    expect(late.destructionEscalation).toBe(false);
  });

  it("keeps diagnostics secret-free and supports duplicate delivery refusal", async () => {
    const { encryptKey, macKey } = await sealingMaterial();
    const pkg = await sealAlertPackage({
      incidentId: "inc-diag",
      profileId: "p",
      routeRef: "r",
      templateRef: "t",
      payload: { kind: "duress_alert" },
      encryptKey,
      macKey,
      expiryMs: 60_000,
      policyRevision: 1,
      keyEpoch: 1,
    });
    const box = new AlertOutbox();
    box.enqueue(pkg, 2);
    await box.attemptDelivery(pkg.packageId, async () => "accepted", macKey);
    const diag = JSON.stringify(box.diagnostics());
    expect(diag).not.toContain(pkg.ciphertextB64);
    expect(diag).not.toContain(pkg.evidenceMacB64);
    expect(diag).not.toMatch(/password|privateKey|rootKey/i);
    await expect(
      box.attemptDelivery(pkg.packageId, async () => "accepted", macKey),
    ).rejects.toThrow(/not_queued/);
  });

  it("expires revoked/expired routes before arming", () => {
    const reg = new AlertRouteRegistry();
    reg.enroll({
      routeRef: "route-exp",
      origin: "https://peer.example/a",
      recipientPrincipalRef: "u",
      templateRef: "t",
      consentedAt: new Date(0).toISOString(),
      expiresAt: new Date(1_000).toISOString(),
    });
    reg.markTestPassed("route-exp", new Date(500).toISOString());
    expect(() => reg.assertReady("route-exp", 50_000)).toThrow(/expired/);
  });
});
