import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { kvDelete, kvFlush, kvGet } from "../kv.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { vaultStore } from "../vault/store.js";
import { PERSONAL_TOMB, tombFileKey, vfsSeams } from "../vfs.js";
import { LiveGuest } from "./guest.js";
import { captureHostAuthority } from "./host-authority.js";
import { deferred, settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import { DIRECT_ONLY } from "./peer.js";
import { NO_ROUTES, linkRoutes } from "./routes.js";
import {
  currentHost,
  currentHostCarriers,
  endHosting,
  leaveLive,
  startHosting,
} from "./session.js";
import { transportReadiness } from "./transport-readiness.js";
import {
  TRANSPORT_PATH,
  TransportRefused,
  readLiveTransport,
  storeSeams,
  writeLiveTransport,
} from "./transport-store.js";
import { DIRECT_TRANSPORT, type LiveTransport } from "./transport.js";

const RETIRED = "generated configuration retired secret";
const SECRET = "generated configuration owner field";
const TRANSPORT_KEY = tombFileKey(PERSONAL_TOMB, TRANSPORT_PATH);
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let item = plainAccount("Generated configuration account", SECRET);
const guests: LiveGuest[] = [];
const releases: (() => void)[] = [];
const pendingWork: Promise<unknown>[] = [];

beforeEach(async () => {
  vaultStore.lock();
  kvDelete(TRANSPORT_KEY);
  fixture = await createRetiredCredentialFixture();
  item = plainAccount("Generated configuration account", SECRET);
  await fixture.store.saveItem(item);
  await fixture.enroll(RETIRED, "synthetic_decoy");
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(PASSWORD);
  await writeLiveTransport(PERSONAL_TOMB, DIRECT_TRANSPORT);
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vaultStore.lock();
  await Promise.allSettled(pendingWork.splice(0));
  endHosting();
  leaveLive();
  for (const guest of guests.splice(0)) guest.leave();
  vaultStore.lock();
  fixture.restore();
  clearActivePresentation();
  vi.restoreAllMocks();
  kvDelete(TRANSPORT_KEY);
  await kvFlush();
});

function profile(username: string): LiveTransport {
  return {
    ...DIRECT_TRANSPORT,
    ice: [
      {
        urls: ["turn:127.0.0.1:3478?transport=tcp"],
        username,
        credential: "controlled-test-credential",
      },
    ],
    relay: true,
  };
}

async function configuredInput(net: FakeNet) {
  const transport = await readLiveTransport(PERSONAL_TOMB);
  const admitted = transportReadiness();
  expect(admitted.pending).toBe(0);
  const owner = captureHostAuthority(vaultStore.pinContinuation());
  return {
    title: "Generated configuration room",
    scope: { kind: "vault" as const },
    policy: "read" as const,
    admission: "invite" as const,
    minutes: 1,
    peers: net.factory(),
    transport,
    assertConfiguration: () => {
      owner();
      const now = transportReadiness();
      if (now.pending !== 0 || now.revision !== admitted.revision)
        throw new TransportRefused("Wait for this vault's configured routes");
    },
  };
}

async function syntheticRoundTrip() {
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

async function pair(
  host: Awaited<ReturnType<typeof startHosting>>,
  net: FakeNet,
) {
  const guest = new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Generated configuration joiner",
    note: "",
    ice: DIRECT_ONLY,
    peers: net.factory(),
  });
  guests.push(guest);
  const request = await host.receive(await guest.start());
  if (request.kind !== "guest") throw new Error("Generated request refused");
  await host.admit(request.key);
  expect(await guest.accept(host.state.guests[0]?.reply ?? "")).toBe(true);
  await settle();
  return guest;
}

it("refuses an actual host construction after a real sealed-profile revision changes while its public key export is held", async () => {
  const net = new FakeNet();
  const input = await configuredInput(net);
  const before = kvGet(TRANSPORT_KEY);
  expect(before).not.toBeNull();
  const reached = deferred();
  const held = deferred();
  releases.push(held.release);
  const exportKey = crypto.subtle.exportKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "exportKey").mockImplementationOnce(
    async (...args) => {
      const publicKey = await exportKey(...args);
      reached.release();
      await held.promise;
      return publicKey;
    },
  );
  const pending = startHosting(input).catch((error: Error) => error);
  pendingWork.push(pending);
  try {
    await reached.promise;
    await writeLiveTransport(
      PERSONAL_TOMB,
      profile("new-construction-profile"),
    );
    expect(kvGet(TRANSPORT_KEY)).not.toBe(before);
    expect(await readLiveTransport(PERSONAL_TOMB)).toEqual(
      profile("new-construction-profile"),
    );
    expect(transportReadiness().pending).toBe(0);
    expect(() => input.assertConfiguration()).toThrow(TransportRefused);
  } finally {
    held.release();
  }
  expect(await pending).toBeInstanceOf(TransportRefused);
  expect(currentHost()).toBeNull();
  expect(currentHostCarriers()).toBeNull();
  expect(net.created).toBe(0);
  // A separately captured settled profile may construct the actual new link.
  const fresh = await startHosting(await configuredInput(net));
  expect(currentHost()).toBe(fresh);
  expect(linkRoutes(fresh.link)).toEqual({
    ice: profile("new-construction-profile").ice,
    relay: true,
    carriers: [],
  });
});

it("keeps an established host's original routes after a profile edit while retaining its original owner ceiling", async () => {
  const net = new FakeNet();
  const input = await configuredInput(net);
  const host = await startHosting(input);
  const guest = await pair(host, net);
  expect(await guest.request("reveal", item.id, "password")).toBe(SECRET);
  const before = kvGet(TRANSPORT_KEY);
  await writeLiveTransport(PERSONAL_TOMB, profile("later-profile"));
  expect(kvGet(TRANSPORT_KEY)).not.toBe(before);
  expect(await readLiveTransport(PERSONAL_TOMB)).toEqual(
    profile("later-profile"),
  );
  expect(() => input.assertConfiguration()).toThrow(TransportRefused);
  expect(currentHost()).toBe(host);
  expect(host.state.status).toBe("live");
  expect(host.link.routes).toBeNull();
  expect(linkRoutes(host.link)).toEqual(NO_ROUTES);
  expect(await guest.request("reveal", item.id, "password")).toBe(SECRET);
  await syntheticRoundTrip();
  expect(currentHost()).toBeNull();
  expect(host.state.status).toBe("ended");
  expect(await guest.request("reveal", item.id, "password")).toBeNull();
  // The fresh owner does not revive the previous session; fresh hosting works.
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  const fresh = await startHosting(await configuredInput(new FakeNet()));
  expect(currentHost()).toBe(fresh);
});

it.each(["lock", "synthetic"] as const)(
  "refuses queued profile writes after locking the original owner before %s recovery",
  async (retirement) => {
    const owner = captureHostAuthority(vaultStore.pinContinuation());
    const before = kvGet(TRANSPORT_KEY);
    expect(before).not.toBeNull();
    const reached = deferred();
    const held = deferred();
    releases.push(held.release);
    const seal = vfsSeams.seal;
    vi.spyOn(vfsSeams, "seal").mockImplementationOnce(async (...args) => {
      const encrypted = await seal(...args);
      reached.release();
      await held.promise;
      return encrypted;
    });
    const dispatch = vi.spyOn(storeSeams, "write");
    const durable = vi.spyOn(vfsSeams, "writeRaw");
    const first = writeLiveTransport(
      PERSONAL_TOMB,
      profile("held-original"),
      owner,
    ).catch((error: Error) => error);
    pendingWork.push(first);
    await reached.promise;
    const queued = writeLiveTransport(
      PERSONAL_TOMB,
      profile("queued-original"),
      owner,
    ).catch((error: Error) => error);
    pendingWork.push(queued);
    let recovery: Promise<Error | null> | null = null;
    try {
      expect(transportReadiness().pending).toBe(2);
      vaultStore.lock();
      if (retirement === "synthetic") {
        recovery = syntheticRoundTrip().then(
          () => null,
          (error: Error) => error,
        );
        pendingWork.push(recovery);
      }
      expect(() => owner()).toThrow();
      durable.mockClear();
    } finally {
      held.release();
    }
    expect(await first).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    if (recovery) expect(await recovery).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(durable.mock.calls.filter(([key]) => key === TRANSPORT_KEY)).toEqual(
      [],
    );
    expect(kvGet(TRANSPORT_KEY)).toBe(before);
    await vaultStore.unlock(PASSWORD);
    expect(await readLiveTransport(PERSONAL_TOMB)).toEqual(DIRECT_TRANSPORT);
    expect(transportReadiness().pending).toBe(0);
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    await writeLiveTransport(
      PERSONAL_TOMB,
      profile("fresh-owner"),
      captureHostAuthority(vaultStore.pinContinuation()),
    );
    expect(await readLiveTransport(PERSONAL_TOMB)).toEqual(
      profile("fresh-owner"),
    );
  },
);
