import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { vaultStore } from "../vault/store.js";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { deferred, settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import { DIRECT_ONLY } from "./peer.js";
import {
  currentGuest,
  currentHost,
  endHosting,
  joinLive,
  leaveLive,
  startHosting,
} from "./session.js";
import { vaultCatalog, vaultField } from "./vault-share.js";

const RETIRED = "generated live retired secret";
const SECRET = "generated live owner field";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const hosts: LiveHost[] = [];
const guests: LiveGuest[] = [];
let item = plainAccount("Generated live account", SECRET);
beforeEach(async () => {
  vaultStore.lock();
  fixture = await createRetiredCredentialFixture();
  item = plainAccount("Generated live account", SECRET);
  await fixture.store.saveItem(item);
  await fixture.enroll(RETIRED, "synthetic_decoy");
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(PASSWORD);
});
afterEach(() => {
  endHosting();
  leaveLive();
  for (const host of hosts.splice(0)) host.end();
  for (const guest of guests.splice(0)) guest.leave();
  vaultStore.lock();
  fixture.restore();
  clearActivePresentation();
  vi.restoreAllMocks();
});

async function successor(): Promise<void> {
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, RETIRED),
  ).resolves.toBe("retired_credential_session");
  expect(fixture.store.getSnapshot().decoy).toBe(true);
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    decoy: false,
  });
}
function options(net: FakeNet) {
  // These are actual decrypted items from the admitted generated owner,
  // captured by a permitted protocol source, not invented plaintext fixtures.
  const items = fixture.store.getSnapshot().items;
  const source = { scope: { kind: "vault" as const }, items: () => items };
  return {
    admission: "invite" as const,
    ice: DIRECT_ONLY,
    expiresAt: Date.now() + 60_000,
    catalog: () =>
      vaultCatalog({
        ...source,
        title: "Generated room",
        policy: "read",
        expiresAt: Date.now() + 60_000,
      }),
    readField: vaultField(source),
    peers: net.factory(),
  };
}
async function pair(host: LiveHost, net: FakeNet) {
  const guest = new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Generated joiner",
    note: "",
    ice: DIRECT_ONLY,
    peers: net.factory(),
  });
  guests.push(guest);
  const received = await host.receive(await guest.start());
  if (received.kind !== "guest") throw new Error("Generated request refused");
  await host.admit(received.key);
  const reply = host.state.guests[0]?.reply;
  expect(await guest.accept(reply ?? "")).toBe(true);
  await settle();
  return guest;
}

it("does not send a held real plaintext field after another Store enters a selected synthetic realm and fresh owner", async () => {
  const net = new FakeNet();
  const reached = deferred();
  const held = deferred();
  const input = options(net);
  const read = input.readField;
  input.readField = async (...args) => {
    const value = await read(...args);
    expect(value === SECRET).toBe(true);
    reached.release();
    await held.promise;
    return value;
  };
  const host = await LiveHost.start(input);
  hosts.push(host);
  const guest = await pair(host, net);
  const channel = net.peers.find((peer) => peer.answering)?.channel;
  if (!channel) throw new Error("Generated owner channel did not open");
  const frames: string[] = [];
  const send = channel.send.bind(channel);
  vi.spyOn(channel, "send").mockImplementation((frame) => {
    frames.push(frame);
    send(frame);
  });
  const pending = guest.request("reveal", item.id, "password");
  await reached.promise;
  await successor();
  held.release();
  await settle();
  expect(frames.some((frame) => frame.includes(SECRET))).toBe(false);
  expect(await pending).toBeNull();
  expect(host.state.status).toBe("ended");
});

it("rejects a direct host start inside an actual selected synthetic realm", async () => {
  const net = new FakeNet();
  const input = options(net);
  fixture.store.lock();
  await unlockWithRetiredCredentialGate(fixture.store, RETIRED);
  const result = await LiveHost.start(input).then(
    (host) => {
      hosts.push(host);
      return host;
    },
    (error: Error) => error,
  );
  expect(result instanceof Error).toBe(true);
});

it("withholds a production host built with original owner keys across a synthetic round trip", async () => {
  const net = new FakeNet();
  const reached = deferred();
  const held = deferred();
  const exportKey = crypto.subtle.exportKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "exportKey").mockImplementationOnce(
    async (...args) => {
      const result = await exportKey(...args);
      reached.release();
      await held.promise;
      return result;
    },
  );
  const pending = startHosting({
    title: "Generated production room",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 1,
    peers: net.factory(),
  }).then(
    (host) => {
      hosts.push(host);
      return host;
    },
    (error: Error) => error,
  );
  await reached.promise;
  await successor();
  held.release();
  expect((await pending) instanceof Error).toBe(true);
  expect(currentHost()).toBeNull();
});

it("does not let an old held join cleanup close the genuinely fresh current guest", async () => {
  const oldNet = new FakeNet();
  const oldHost = await LiveHost.start(options(oldNet));
  hosts.push(oldHost);
  const reached = deferred();
  const held = deferred();
  oldNet.holdOffer = held.promise;
  const peers = oldNet.factory();
  const oldJoin = joinLive({
    link: oldHost.link,
    code: oldHost.code,
    name: "Generated old joiner",
    note: "",
    peers: (...args) => {
      const peer = peers(...args);
      reached.release();
      return peer;
    },
    useRoutes: false,
  }).catch((error: Error) => error);
  await reached.promise;
  await successor();
  const net = new FakeNet();
  const freshHost = await LiveHost.start(options(net));
  hosts.push(freshHost);
  const freshGuest = await joinLive({
    link: freshHost.link,
    code: freshHost.code,
    name: "Generated fresh joiner",
    note: "",
    peers: net.factory(),
    useRoutes: false,
  });
  held.release();
  expect((await oldJoin) instanceof Error).toBe(true);
  expect(currentGuest()).toBe(freshGuest);
  const status = freshGuest.status;
  if (status.at !== "request") throw new Error("Fresh request did not open");
  const request = await freshHost.receive(status.code);
  if (request.kind !== "guest") throw new Error("Fresh request was refused");
  await freshHost.admit(request.key);
  expect(await freshGuest.accept(freshHost.state.guests[0]?.reply ?? "")).toBe(
    true,
  );
  await settle();
  expect(
    (await freshGuest.request("reveal", item.id, "password")) === SECRET,
  ).toBe(true);
});

it("refuses an actual sealed request whose decrypt returns after the original real realm retired", async () => {
  const net = new FakeNet();
  const host = await LiveHost.start(options(net));
  hosts.push(host);
  const guest = new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Generated joiner",
    note: "",
    ice: DIRECT_ONLY,
    peers: net.factory(),
  });
  guests.push(guest);
  const request = await guest.start();
  const reached = deferred();
  const held = deferred();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    const result = await decrypt(...args);
    reached.release();
    await held.promise;
    return result;
  });
  const pending = host.receive(request);
  await reached.promise;
  await successor();
  held.release();
  expect(await pending).toEqual({ kind: "ended" });
  expect(host.state.guests).toEqual([]);
  expect(net.created).toBe(1);
});

it("allows a fresh real host to read the actual owner vault after the previous realm retired", async () => {
  await successor();
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  const net = new FakeNet();
  const host = await startHosting({
    title: "Generated fresh room",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 1,
    peers: net.factory(),
  });
  const guest = await pair(host, net);
  expect((await guest.request("reveal", item.id, "password")) === SECRET).toBe(
    true,
  );
});

it("hosts a legitimate unlocked Skip guest with its original ephemeral key and entered item", async () => {
  vaultStore.lock();
  await vaultStore.createGuest();
  expect(vaultStore.getSnapshot()).toMatchObject({ guest: true, decoy: false });
  await vaultStore.saveItem(item);
  const net = new FakeNet();
  const host = await startHosting({
    title: "Generated Skip room",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 1,
    peers: net.factory(),
  });
  const guest = await pair(host, net);
  expect((await guest.request("reveal", item.id, "password")) === SECRET).toBe(
    true,
  );
});

it("withholds a real relayed value whose AES seal completes after a synthetic round trip", async () => {
  const net = new FakeNet();
  const bus = new FakeBus();
  const host = await startHosting({
    title: "Generated relayed room",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 1,
    peers: net.factory(),
    transport: {
      addresses: [],
      ice: [],
      relay: false,
      carriers: [
        {
          kind: "nats",
          url: "wss://generated.example.invalid",
          session: "always",
        },
      ],
    },
    carriers: bus.factory(),
  });
  await settle();
  const guest = await joinLive({
    link: host.link,
    code: host.code,
    name: "Generated relayed joiner",
    note: "",
    peers: net.factory(),
    useRoutes: true,
    carriers: bus.factory(),
  });
  await settle();
  const joined = new Promise<void>((resolve) => {
    guest.subscribe((state) => {
      if (state.at === "joined") resolve();
    });
  });
  await host.admit(host.state.guests[0]?.key ?? "");
  await joined;
  const reached = deferred();
  const held = deferred();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let intercepted = false;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
    const result = await encrypt(...args);
    if (!intercepted && new TextDecoder().decode(args[2]).includes(SECRET)) {
      intercepted = true;
      reached.release();
      await held.promise;
    }
    return result;
  });
  const pending = guest.request("reveal", item.id, "password");
  await reached.promise;
  await successor();
  const afterRetirement = bus.seen.length;
  held.release();
  await settle();
  expect(intercepted).toBe(true);
  expect(bus.seen.length).toBe(afterRetirement);
  expect(await pending).toBeNull();
  expect(currentHost()).toBeNull();
});
