import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { fakeIndexedDb } from "../at-rest/fake-idb.test-support.js";
import { commitPeerTrustEnrollment } from "../peer-trust/store.js";
import {
  buildPeerTrustSignal,
  encodePeerTrustSignal,
} from "../peer-trust/signaling.js";
import {
  createLivePeerJoinApproval,
  exportLivePeerTrustSignal,
  gateLivePeerTrustSignal,
} from "./peer-trust-peering.js";

describe("live peer trust peering (PWA-only)", () => {
  afterEach(() => {
    configureHost(createTestHost());
  });

  it("exports a signal after enroll and admits it on the peer", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const owner = await exportLivePeerTrustSignal();
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;

    const { factory: joinerDb } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: joinerDb }));
    await commitPeerTrustEnrollment(undefined);

    const admit = await gateLivePeerTrustSignal(owner.signal);
    expect(admit.ok).toBe(true);
    if (!admit.ok) return;
    expect(admit.spkiFingerprint).toBe(owner.spkiFingerprint);
    expect(admit.sas).toBe(owner.sas);
  });

  it("refuses changed-key admit when a fingerprint is remembered", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const owner = await exportLivePeerTrustSignal();
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;

    const otherFp = `${"a".repeat(62)}bb`;
    const admit = await gateLivePeerTrustSignal(owner.signal, otherFp);
    expect(admit.ok).toBe(false);
    if (admit.ok) return;
    expect(admit.reason).toBe("changed-key");
  });

  it("refuses epoch downgrade when minimumEpoch is ahead of the signal", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const committed = await commitPeerTrustEnrollment(undefined);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const signal = buildPeerTrustSignal(committed.envelope);
    expect(signal).not.toBeNull();
    if (!signal) return;
    const raw = encodePeerTrustSignal(signal);
    const behind = await gateLivePeerTrustSignal(raw, undefined, 99);
    expect(behind.ok).toBe(false);
    if (behind.ok) return;
    expect(behind.reason).toBe("epoch-behind");
  });

  it("clears pending when more than one peer join is queued", () => {
    const gate = createLivePeerJoinApproval();
    gate.requestJoinApproval("peer-a");
    gate.requestJoinApproval("peer-b");
    expect(gate.queue.listPending()).toHaveLength(0);
  });

  it("blocks software passkeys on high-risk peer verbs", () => {
    const gate = createLivePeerJoinApproval();
    expect(gate.passkeyAllowsVerb("software-passkey", "peer-reveal")).toBe(
      false,
    );
    expect(gate.passkeyAllowsVerb("passkey", "peer-reveal")).toBe(true);
    expect(gate.passkeyAllowsVerb("software-passkey", "peer-join")).toBe(true);
  });
});
