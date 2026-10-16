import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { fakeIndexedDb } from "../at-rest/fake-idb.test-support.js";
import {
  buildPeerTrustSignal,
  encodePeerTrustSignal,
} from "../peer-trust/signaling.js";
import { commitPeerTrustEnrollment } from "../peer-trust/store.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import {
  createLivePeerJoinApproval,
  exportLivePeerTrustSignal,
  gateLivePeerTrustSignal,
} from "./peer-trust-peering.js";
import { endHosting, joinLive, leaveLive, startHosting } from "./session.js";
import type { LiveTransport } from "./transport.js";

const PROFILE: LiveTransport = {
  addresses: [],
  ice: [],
  relay: false,
  carriers: [],
};

describe("live peer trust peering (PWA-only)", () => {
  beforeEach(() => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
  });

  afterEach(() => {
    endHosting();
    leaveLive();
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

  it("joinLive refuses an invalid peer trust signal before connecting", async () => {
    const net = new FakeNet();
    const bus = new FakeBus();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "open",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
      carriers: bus.factory(),
    });
    await expect(
      joinLive({
        link: owner.link,
        code: null,
        name: "Joiner",
        note: "",
        transport: net.transports(),
        useRoutes: false,
        peerTrustSignal: "not-a-valid-signal",
      }),
    ).rejects.toThrow(/peer_trust_refused:invalid-signal/);
  });

  it("joinLive admits a valid exported signal on the joiner", async () => {
    const ownerExport = await exportLivePeerTrustSignal();
    expect(ownerExport.ok).toBe(true);
    if (!ownerExport.ok) return;

    const net = new FakeNet();
    const bus = new FakeBus();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "open",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
      carriers: bus.factory(),
    });
    const guest = await joinLive({
      link: owner.link,
      code: null,
      name: "Joiner",
      note: "",
      transport: net.transports(),
      useRoutes: false,
      peerTrustSignal: ownerExport.signal,
    });
    expect(guest).toBeTruthy();
    guest.leave();
  });
});
