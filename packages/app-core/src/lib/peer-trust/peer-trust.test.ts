import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { fakeIndexedDb } from "../at-rest/fake-idb.test-support.js";
import { compareRootTrustFingerprint } from "./alarm.js";
import { PeerApprovalQueue } from "./approval-queue.js";
import { signPeerTrustEnvelope, verifyPeerTrustEnvelope } from "./envelope.js";
import { fingerprintOfSpki } from "./fingerprint.js";
import {
  humanProofKindAllowsVerb,
  verbRequiresHardwarePasskey,
} from "./human-proof-tier.js";
import { parsePeerTrustSignal } from "./parse.js";
import { parsePeerTrustRecord } from "./record.js";
import { sasFromFingerprint } from "./sas.js";
import {
  buildPeerTrustSignal,
  decodePeerTrustSignal,
  encodePeerTrustSignal,
  verifyPeerTrustSignal,
} from "./signaling.js";
import { commitPeerTrustEnrollment, loadPeerTrustStore } from "./store.js";

describe("peer trust record", () => {
  it("parses a canonical fingerprint and positive epoch", async () => {
    const fp = await fingerprintOfSpki(new Uint8Array([9, 9, 9]));
    const record = parsePeerTrustRecord({
      spkiFingerprint: fp,
      enrollmentEpoch: 1,
    });
    expect(record).not.toBe("invalid");
    if (record !== "invalid") {
      expect(record.enrollmentEpoch).toBe(1);
    }
  });

  it("rejects zero epoch and bad fingerprint", () => {
    expect(
      parsePeerTrustRecord({ spkiFingerprint: "ab", enrollmentEpoch: 1 }),
    ).toBe("invalid");
    expect(
      parsePeerTrustRecord({
        spkiFingerprint: "a".repeat(64),
        enrollmentEpoch: 0,
      }),
    ).toBe("invalid");
  });
});

describe("SAS and alarms", () => {
  it("formats SAS from fingerprint", async () => {
    const fp = await fingerprintOfSpki(new Uint8Array([1]));
    expect(sasFromFingerprint(fp)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(compareRootTrustFingerprint(undefined, fp).kind).toBe("none");
    expect(compareRootTrustFingerprint(fp, fp).kind).toBe("none");
    expect(compareRootTrustFingerprint(fp, `${fp.slice(0, 62)}00`).kind).toBe(
      "changed",
    );
  });
});

describe("human proof tiering", () => {
  it("blocks software passkeys on high-risk peer and CLI verbs", () => {
    for (const verb of ["peer-reveal", "run", "pass-reveal"]) {
      expect(verbRequiresHardwarePasskey(verb)).toBe(true);
      expect(humanProofKindAllowsVerb("software-passkey", verb)).toBe(false);
      expect(humanProofKindAllowsVerb("passkey", verb)).toBe(true);
    }
    expect(humanProofKindAllowsVerb("software-passkey", "peer-join")).toBe(
      true,
    );
  });
});

describe("peer approval queue", () => {
  it("refuses all when more than one pending", () => {
    const now = 1_000;
    const q = new PeerApprovalQueue(() => now);
    q.ensure("peer-a", "peer-join");
    q.ensure("peer-b", "peer-join");
    expect(q.listPending()).toHaveLength(0);
  });

  it("coalesces identical pending rows", () => {
    const q = new PeerApprovalQueue();
    const first = q.ensure("peer-a", "peer-join", "ref");
    const second = q.ensure("peer-a", "peer-join", "ref");
    expect(first.requestId).toBe(second.requestId);
  });

  it("rate limits burst ensure calls for one peer session", () => {
    let now = 0;
    const q = new PeerApprovalQueue(() => now);
    const session = "peer-a";
    for (let i = 0; i < 8; i += 1) {
      expect(q.ensure(session, "peer-join").status).toBe("pending");
      now += 1;
    }
    expect(q.ensure(session, "peer-join").status).toBe("denied");
  });
});

describe("signed peer trust store (IndexedDB)", () => {
  afterEach(() => {
    configureHost(createTestHost());
  });

  it("enrolls, loads, and verifies ARK-signed record", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const committed = await commitPeerTrustEnrollment(undefined);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const loaded = await loadPeerTrustStore();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.enrollmentEpoch).toBe(1);
    expect(loaded.sas).toBe(committed.sas);
  });

  it("refuses persisted epoch below high-water mark", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const first = await commitPeerTrustEnrollment(undefined);
    expect(first.ok).toBe(true);
    const second = await commitPeerTrustEnrollment(undefined);
    expect(second.ok).toBe(true);
    const loaded = await loadPeerTrustStore();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.enrollmentEpoch).toBe(2);
  });

  it("bumps epoch on re-enrollment", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    await commitPeerTrustEnrollment(undefined);
    const second = await commitPeerTrustEnrollment(undefined);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.record.enrollmentEpoch).toBe(2);
  });

  it("round-trips signaling encode/decode", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const committed = await commitPeerTrustEnrollment(undefined);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const signal = buildPeerTrustSignal(committed.envelope);
    expect(signal).not.toBeNull();
    if (!signal) return;
    const raw = encodePeerTrustSignal(signal);
    const boundary = JSON.parse(raw);
    expect(parsePeerTrustSignal(boundary)).not.toBeNull();
    const decoded = decodePeerTrustSignal(raw);
    expect(decoded).not.toBeNull();
    expect(await verifyPeerTrustSignal(signal)).toBe(true);
  });

  it("rejects tampered envelope signature", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    const fp = await fingerprintOfSpki(spki);
    const record = parsePeerTrustRecord({
      spkiFingerprint: fp,
      enrollmentEpoch: 1,
    });
    if (record === "invalid") throw new Error("record");
    let binary = "";
    for (const byte of spki) binary += String.fromCharCode(byte);
    const envelope = await signPeerTrustEnvelope(
      pair.privateKey,
      record,
      btoa(binary),
    );
    const bad = { ...envelope, enrollmentEpoch: 99 };
    expect(await verifyPeerTrustEnvelope(bad)).toBe(false);
  });
});
