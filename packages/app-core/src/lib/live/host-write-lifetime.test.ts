import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { plainAccount } from "../account.test-support.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { vaultStore } from "../vault/store.js";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import { LiveGuest } from "./guest.js";
import { deferred, settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import { DIRECT_ONLY } from "./peer.js";
import { endHosting, startHosting } from "./session.js";
import { vaultField } from "./vault-share.js";

const ORIGINAL = "generated original live write";
const REPLACEMENT = "generated replacement live write";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let guest: LiveGuest | null = null;
let item = plainAccount("Generated writable account", ORIGINAL);

beforeEach(async () => {
  vaultStore.lock();
  fixture = await createRetiredCredentialFixture();
  item = plainAccount("Generated writable account", ORIGINAL);
  await fixture.store.saveItem(item);
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(PASSWORD);
});
afterEach(() => {
  endHosting();
  guest?.leave();
  guest = null;
  vaultStore.lock();
  fixture.restore();
  vi.restoreAllMocks();
});

it.each(["end", "refuse"] as const)(
  "does not commit a real edit held at AES encryption after the original Host seat %s",
  async (retire) => {
    const net = new FakeNet();
    const host = await startHosting({
      title: "Generated writable room",
      scope: { kind: "vault" },
      policy: "edit",
      admission: "invite",
      minutes: 1,
      peers: net.factory(),
    });
    guest = new LiveGuest({
      link: host.link,
      code: host.code,
      name: "Generated writer",
      note: "",
      ice: DIRECT_ONLY,
      peers: net.factory(),
    });
    const request = await host.receive(await guest.start());
    if (request.kind !== "guest") throw new Error("Write request refused");
    await host.admit(request.key);
    expect(await guest.accept(host.state.guests[0]?.reply ?? "")).toBe(true);
    await settle();
    const previous = readSealedFile("personal", BODY_PATH);
    const previousItems = structuredClone(vaultStore.getSnapshot().items);
    expect(previous).not.toBeNull();
    const reached = deferred();
    const held = deferred();
    const saved = deferred();
    const save = vaultStore.saveItem.bind(vaultStore);
    vi.spyOn(vaultStore, "saveItem").mockImplementation((...args) =>
      save(...args).finally(saved.release),
    );
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let intercepted = false;
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      const sealed = await encrypt(...args);
      if (
        !intercepted &&
        new TextDecoder().decode(args[2]).includes(REPLACEMENT)
      ) {
        intercepted = true;
        reached.release();
        await held.promise;
      }
      return sealed;
    });
    const pending = guest.edit(item.id, "password", REPLACEMENT);
    try {
      await reached.promise;
      if (retire === "end") host.end();
      else host.refuse(request.key);
      expect(vaultStore.getSnapshot().status).toBe("unlocked");
    } finally {
      held.release();
      await saved.promise;
    }
    expect(await pending).toBeNull();
    expect(
      JSON.stringify(readSealedFile("personal", BODY_PATH)) ===
        JSON.stringify(previous),
    ).toBe(true);
    expect(
      JSON.stringify(vaultStore.getSnapshot().items) ===
        JSON.stringify(previousItems),
    ).toBe(true);
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    expect(
      JSON.stringify(vaultStore.getSnapshot().items) ===
        JSON.stringify(previousItems),
    ).toBe(true);
  },
);

it("commits a genuine live edit while the original owner and seat remain current", async () => {
  const net = new FakeNet();
  const host = await startHosting({
    title: "Generated writable room",
    scope: { kind: "vault" },
    policy: "edit",
    admission: "invite",
    minutes: 1,
    peers: net.factory(),
  });
  guest = new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Generated writer",
    note: "",
    ice: DIRECT_ONLY,
    peers: net.factory(),
  });
  const request = await host.receive(await guest.start());
  if (request.kind !== "guest") throw new Error("Write request refused");
  await host.admit(request.key);
  expect(await guest.accept(host.state.guests[0]?.reply ?? "")).toBe(true);
  await settle();
  expect(
    (await guest.edit(item.id, "password", REPLACEMENT)) === REPLACEMENT,
  ).toBe(true);
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  const read = vaultField({
    scope: { kind: "vault" },
    items: () => vaultStore.getSnapshot().items,
  });
  expect((await read(item.id, "password")) === REPLACEMENT).toBe(true);
});

it.each(["end", "refuse"] as const)(
  "closes the original owner peer immediately when the answer is held and the Host seat %s",
  async (retire) => {
    const net = new FakeNet();
    const reached = deferred();
    const held = deferred();
    const peers = net.factory();
    const host = await startHosting({
      title: "Generated held answer",
      scope: { kind: "vault" },
      policy: "read",
      admission: "invite",
      minutes: 1,
      peers: (config) => {
        const peer = peers(config);
        reached.release();
        return peer;
      },
    });
    guest = new LiveGuest({
      link: host.link,
      code: host.code,
      name: "Generated joiner",
      note: "",
      ice: DIRECT_ONLY,
      peers,
    });
    const request = await host.receive(await guest.start());
    if (request.kind !== "guest") throw new Error("Held request refused");
    net.holdAnswer = held.promise;
    const admitting = host.admit(request.key);
    await reached.promise;
    const owner = net.peers[1];
    expect(owner?.closed).toBe(false);
    try {
      if (retire === "end") host.end();
      else host.refuse(request.key);
      expect(owner?.closed).toBe(true);
    } finally {
      held.release();
      await admitting;
    }
    expect(host.state.guests[0]?.reply).toBeNull();
  },
);
