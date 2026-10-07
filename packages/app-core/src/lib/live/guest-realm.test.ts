/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetRealmFixture } from "../__tests__/reset-realm-fixture.js";
import {
  currentSyntheticTransition,
  markDecoySession,
  onSyntheticTransition,
} from "../decoy-session.js";
import { createRetiredCredentialFixture } from "../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { deferred, settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import { DIRECT_ONLY } from "./peer.js";

const guests: LiveGuest[] = [];
const hosts: LiveHost[] = [];
beforeEach(resetRealmFixture);
afterEach(() => {
  for (const guest of guests.splice(0)) guest.leave();
  for (const host of hosts.splice(0)) host.end();
  vi.restoreAllMocks();
  resetRealmFixture();
});
async function fixture(net = new FakeNet()) {
  const host = await LiveHost.start({
    admission: "open",
    ice: DIRECT_ONLY,
    expiresAt: Date.now() + 60_000,
    catalog: () => ({
      title: "Fixture",
      policy: "read",
      expiresAt: Date.now() + 60_000,
      items: [],
    }),
    readField: async () => null,
    peers: net.factory(),
  });
  hosts.push(host);
  const post = vi.fn(async (_code: string) => undefined);
  const close = vi.fn();
  const guest = new LiveGuest({
    link: host.link,
    code: null,
    name: "Fixture joiner",
    note: "",
    ice: DIRECT_ONLY,
    peers: net.factory(),
    carriers: { post, close },
  });
  guests.push(guest);
  return { guest, net, post, close, host };
}

it("closes the original peer and carrier immediately at synthetic entry without a getter or timer", async () => {
  const { guest, net, post, close } = await fixture();
  expect(await guest.start()).not.toBe("");
  expect(post).toHaveBeenCalledTimes(1);
  expect(net.peers[0]?.closed).toBe(false);
  markDecoySession(true);
  expect(net.peers[0]?.closed).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  resetRealmFixture();
  expect(await guest.start()).toBe("");
  expect(await guest.accept("not a reply")).toBe(false);
  expect(await guest.request("copy", "item", "field")).toBeNull();
  expect(await guest.edit("item", "field", "value")).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

it("withholds a genuine request and closes a peer whose offer completes after retirement", async () => {
  const net = new FakeNet();
  const hold = deferred();
  net.holdOffer = hold.promise;
  const { guest, post, close } = await fixture(net);
  const pending = guest.start();
  await settle(10);
  expect(net.peers).toHaveLength(1);
  markDecoySession(true);
  expect(net.peers[0]?.closed).toBe(true);
  resetRealmFixture();
  hold.release();
  expect(await pending).toBe("");
  expect(net.peers[0]?.closed).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});

it("ordinary real lock transitions keep the independent guest request and carriers usable", async () => {
  const { guest, net, post, close, host } = await fixture();
  const request = await guest.start();
  markDecoySession(false);
  expect(guest.status).toMatchObject({ at: "request", code: request });
  expect(net.peers[0]?.closed).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledTimes(1);
  expect((await host.receive(request)).kind).toBe("guest");
});

it("constructing a guest cannot create authority in a synthetic or pending-owner realm", async () => {
  const { guest, host } = await fixture();
  const options = {
    link: host.link,
    code: null,
    name: "Fixture",
    note: "",
    ice: DIRECT_ONLY,
    peers: new FakeNet().factory(),
  };
  markDecoySession(true);
  expect(() => new LiveGuest(options)).toThrow(/authenticate again/);
  markDecoySession(false);
  expect(() => new LiveGuest(options)).toThrow(/authenticate again/);
  expect(await guest.start()).toBe("");
});

it("retires an owned pending transport even when pending-owner persistence throws", async () => {
  const { guest, net, close } = await fixture();
  expect(await guest.start()).not.toBe("");
  const failure = new Error("controlled pending persistence failure");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw failure;
  });
  let thrown: unknown;
  try {
    markDecoySession(true);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(failure);
  expect(net.peers[0]?.closed).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

it("a genuine default retired-password rejection does not retire the independent guest", async () => {
  const owner = await createRetiredCredentialFixture();
  let stop = () => {};
  try {
    const retired = "controlled-record-reject-live-fixture";
    await owner.enroll(retired);
    const { guest, net, close } = await fixture();
    const request = await guest.start();
    const before = currentSyntheticTransition();
    const observed = vi.fn();
    stop = onSyntheticTransition(observed);
    owner.store.lock();
    await expect(
      unlockWithRetiredCredentialGate(owner.store, retired),
    ).rejects.toThrow();
    expect(owner.store.getSnapshot().status).toBe("locked");
    expect(currentSyntheticTransition()).toBe(before);
    expect(observed).not.toHaveBeenCalled();
    expect(net.peers[0]?.closed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(guest.status).toMatchObject({ at: "request", code: request });
  } finally {
    stop();
    owner.restore();
  }
});
