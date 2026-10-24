import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { fakeIndexedDb } from "../at-rest/fake-idb.test-support.js";
import { PeerApprovalQueue } from "../peer-trust/approval-queue.js";
import { FakeNet } from "./live-fakes.js";
import { classifyDuplicateName } from "./peer-trust-join.js";
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

describe("peer trust gate", () => {
  beforeEach(() => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
  });

  afterEach(() => {
    endHosting();
    leaveLive();
    configureHost(createTestHost());
  });

  it("refuses an empty signal instead of skipping the gate", async () => {
    const net = new FakeNet();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "open",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
    });
    await expect(
      joinLive({
        link: owner.link,
        code: null,
        name: "Joiner",
        note: "",
        transport: net.transports(),
        useRoutes: false,
        peerTrustSignal: "   ",
      }),
    ).rejects.toThrow(/peer_trust_refused:missing-signal/);
    expect(await gateLivePeerTrustSignal("")).toMatchObject({
      ok: false,
      reason: "missing-signal",
    });
  });

  it("blocks a changed key", async () => {
    const exported = await exportLivePeerTrustSignal();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const remembered = `${"ab".repeat(32)}`;
    const gated = await gateLivePeerTrustSignal(exported.signal, remembered);
    expect(gated.ok).toBe(false);
    if (gated.ok) return;
    expect(gated.reason).toBe("changed-key");
    const net = new FakeNet();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "invite",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
    });
    await expect(
      joinLive({
        link: owner.link,
        code: owner.code,
        name: "Joiner",
        note: "",
        transport: net.transports(),
        useRoutes: false,
        peerTrustSignal: exported.signal,
        rememberedPeerFingerprint: remembered,
      }),
    ).rejects.toThrow(/peer_trust_refused:changed-key/);
  });

  it("shows the same SAS on both sides and admits an open session at once", async () => {
    const exported = await exportLivePeerTrustSignal();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const net = new FakeNet();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "open",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
    });
    const guest = await joinLive({
      link: owner.link,
      code: null,
      name: "Ada",
      note: "",
      transport: net.transports(),
      useRoutes: false,
      peerTrustSignal: exported.signal,
    });
    expect(guest.status.at).toBe("request");
    if (guest.status.at !== "request") return;
    const received = await owner.receive(guest.status.code);
    expect(received.kind).toBe("guest");
    const seated = owner.state.guests[0];
    expect(seated?.sas).toBe(guest.status.sas);
    expect(seated?.sas).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(seated?.reply).toBeTruthy();
    expect(owner.state.guests[0]?.state).toBe("replied");
  });

  it("flags a duplicate display name with the same key and warns on a clash", () => {
    const clash = classifyDuplicateName("Ada", "b".repeat(64), [
      { key: "seat-1", name: "Ada", fingerprint: "a".repeat(64) },
    ]);
    expect(clash.duplicate).toBe(false);
    expect(clash.clashKeys).toEqual(["seat-1"]);
    const same = classifyDuplicateName("Ada", "a".repeat(64), [
      { key: "seat-1", name: "Ada", fingerprint: "a".repeat(64) },
    ]);
    expect(same.duplicate).toBe(true);
  });

  it("refuses a second open seat with the same name and key", async () => {
    const exported = await exportLivePeerTrustSignal();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const net = new FakeNet();
    const owner = await startHosting({
      title: "Peer trust",
      scope: { kind: "vault" },
      policy: "read",
      admission: "invite",
      minutes: 30,
      transport: net.transports(),
      routes: PROFILE,
    });
    const first = await joinLive({
      link: owner.link,
      code: owner.code,
      name: "Ada",
      note: "",
      transport: net.transports(),
      useRoutes: false,
      peerTrustSignal: exported.signal,
    });
    expect(first.status.at).toBe("request");
    if (first.status.at !== "request") return;
    await owner.receive(first.status.code);
    expect(owner.state.guests).toHaveLength(1);
    leaveLive();
    const second = await joinLive({
      link: owner.link,
      code: owner.code,
      name: "Ada",
      note: "",
      transport: net.transports(),
      useRoutes: false,
      peerTrustSignal: exported.signal,
    });
    expect(second.status.at).toBe("request");
    if (second.status.at !== "request") return;
    const again = await owner.receive(second.status.code);
    expect(again.kind).toBe("duplicate");
    expect(owner.state.guests).toHaveLength(1);
  });
});

describe("queued peer approvals", () => {
  it("keeps concurrent requests and caps the ninth", () => {
    const queue = new PeerApprovalQueue(() => 1_000, "queue");
    for (let i = 0; i < 8; i += 1) {
      expect(queue.ensure(`peer-${i}`, "peer-join").status).toBe("pending");
    }
    expect(queue.ensure("peer-9", "peer-join").status).toBe("denied");
    expect(queue.listPending()).toHaveLength(8);
    const gate = createLivePeerJoinApproval();
    const first = gate.requestJoinApproval("one");
    gate.requestJoinApproval("two");
    expect(gate.queue.listPending()).toHaveLength(2);
    expect(gate.queue.approve(first.requestId ?? "", "one").status).toBe(
      "approved",
    );
    expect(gate.queue.listPending()).toHaveLength(1);
  });
});
