import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { fakeIndexedDb } from "../at-rest/fake-idb.test-support.js";
import { ensurePeerArkSigningKey } from "../peer-trust/ark-key.js";
import {
  encodePeerTrustSignal,
  signedPeerTrustSignal,
} from "../peer-trust/signaling.js";
import { commitPeerTrustEnrollment } from "../peer-trust/store.js";
import { admitPeerTrustSignal } from "./peer-trust-admit.js";

describe("admitPeerTrustSignal", () => {
  afterEach(() => {
    configureHost(createTestHost());
  });

  it("admits a valid signal and detects fingerprint change", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const committed = await commitPeerTrustEnrollment(undefined);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const ark = await ensurePeerArkSigningKey();
    expect(ark).not.toBeNull();
    if (!ark) return;
    const signal = await signedPeerTrustSignal(
      ark.privateKey,
      committed.envelope,
      "absent",
    );
    expect(signal).not.toBeNull();
    if (!signal) return;
    const raw = encodePeerTrustSignal(signal);
    const first = await admitPeerTrustSignal(raw);
    expect(first.ok).toBe(true);
    const otherFp = `${committed.record.spkiFingerprint.slice(0, 62)}ff`;
    const changed = await admitPeerTrustSignal(raw, otherFp);
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.reason).toBe("changed-key");
  });
});
