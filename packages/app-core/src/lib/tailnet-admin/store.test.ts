import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import { clearVaultSurface } from "../vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "../vault/store.js";
import { PERSONAL_TOMB, tombFileKey, vfsSeams } from "../vfs.js";
import {
  TAILNET_ADMIN_CONFIG_PATH,
  type TailnetAdminPairing,
  readTailnetAdminConfig,
} from "./pairing.js";
import {
  bindTailnetPairing,
  currentTailnetPairing,
  dropTailnetPairing,
  keepTailnetPairing,
  subscribeTailnetPairing,
  tailnetPairingPossible,
  tailnetPairingRevision,
} from "./store.js";

const PIN = "73920146";
const CONFIG = tombFileKey(PERSONAL_TOMB, TAILNET_ADMIN_CONFIG_PATH);
const PAIRING: TailnetAdminPairing = {
  url: "https://desk.tail4c2e.ts.net",
  token: "t".repeat(43),
  origin: "https://ops.example.com",
  role: "manage",
  label: "Owner laptop",
};
let stop: () => void;
let notifications = 0;

beforeEach(async () => {
  vaultStore.lock();
  await clearVaultSurface();
  kvDelete(CONFIG);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin(PIN);
  notifications = 0;
  stop = subscribeTailnetPairing(() => notifications++);
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vaultStore.lock();
  kvDelete(CONFIG);
});

it("seals the bearer and reloads it only under fresh real vault authentication", async () => {
  expect(tailnetPairingPossible()).toBe(true);
  expect(currentTailnetPairing()).toBeNull();
  const began = bindTailnetPairing();
  await keepTailnetPairing(PAIRING, began);
  expect(currentTailnetPairing()).toEqual(PAIRING);
  expect(await readTailnetAdminConfig(PERSONAL_TOMB)).toEqual(PAIRING);
  const ciphertext = kvGet(CONFIG);
  expect(ciphertext).not.toBeNull();
  expect(ciphertext).not.toContain(PAIRING.token);
  expect(tailnetPairingRevision()).toBeGreaterThan(began.revision);
  expect(notifications).toBeGreaterThan(0);
  vaultStore.lock();
  expect(tailnetPairingPossible()).toBe(false);
  expect(currentTailnetPairing()).toBeNull();
  await expect(readTailnetAdminConfig(PERSONAL_TOMB)).rejects.toThrow();
  await expect(vaultStore.unlockWithPin("13572468")).rejects.toThrow();
  expect(currentTailnetPairing()).toBeNull();
  await vaultStore.unlockWithPin(PIN);
  await vi.waitFor(() => expect(currentTailnetPairing()).toEqual(PAIRING));
});

it("rejects stale and foreign vault bindings and preserves a replacement on stale forget", async () => {
  const old = bindTailnetPairing();
  await keepTailnetPairing(PAIRING, old);
  const replacement = {
    ...PAIRING,
    token: "n".repeat(43),
    role: "read" as const,
  };
  await expect(keepTailnetPairing(replacement, old)).rejects.toMatchObject({
    code: "target-changed",
  });
  await expect(
    keepTailnetPairing(replacement, {
      ...bindTailnetPairing(),
      tomb: "other-vault",
    }),
  ).rejects.toMatchObject({ code: "locked" });
  await keepTailnetPairing(replacement, bindTailnetPairing());
  await dropTailnetPairing(old.revision);
  expect(currentTailnetPairing()).toEqual(replacement);
  expect(await readTailnetAdminConfig(PERSONAL_TOMB)).toEqual(replacement);
  await dropTailnetPairing(tailnetPairingRevision());
  expect(currentTailnetPairing()).toBeNull();
  expect(await readTailnetAdminConfig(PERSONAL_TOMB)).toBeNull();
});

it.each([false, true])(
  "does not expose or overwrite the owner pairing from a guest (synthetic=%s)",
  async (decoy) => {
    await keepTailnetPairing(PAIRING, bindTailnetPairing());
    const ciphertext = kvGet(CONFIG);
    const began = bindTailnetPairing();
    vaultStore.lock();
    await vaultStore.createGuest({ decoy, isolated: true, resume: false });
    expect(tailnetPairingPossible()).toBe(false);
    expect(currentTailnetPairing()).toBeNull();
    await expect(keepTailnetPairing(PAIRING, began)).rejects.toMatchObject({
      code: "locked",
    });
    await dropTailnetPairing(tailnetPairingRevision());
    expect(kvGet(CONFIG)).toBe(ciphertext);
  },
);

it("retains both current and durable bearer when the real ciphertext writer refuses replacement", async () => {
  await keepTailnetPairing(PAIRING, bindTailnetPairing());
  const ciphertext = kvGet(CONFIG);
  const revision = tailnetPairingRevision();
  const write = vfsSeams.writeRaw;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, raw) => {
    if (key === CONFIG) throw new Error("pairing storage I/O refused");
    return write(key, raw);
  });
  await expect(
    keepTailnetPairing(
      { ...PAIRING, token: "x".repeat(43) },
      bindTailnetPairing(),
    ),
  ).rejects.toThrow("pairing storage I/O refused");
  expect(currentTailnetPairing()).toEqual(PAIRING);
  expect(kvGet(CONFIG)).toBe(ciphertext);
  expect(tailnetPairingRevision()).toBe(revision);
  vi.restoreAllMocks();
  await keepTailnetPairing(
    { ...PAIRING, label: "Repaired storage" },
    bindTailnetPairing(),
  );
  expect((await readTailnetAdminConfig(PERSONAL_TOMB))?.label).toBe(
    "Repaired storage",
  );
});

it("drops the in-memory bearer when the last panel unsubscribes and rehydrates a new panel", async () => {
  await keepTailnetPairing(PAIRING, bindTailnetPairing());
  let otherChanges = 0;
  const second = subscribeTailnetPairing(() => otherChanges++);
  stop();
  await keepTailnetPairing(
    { ...PAIRING, label: "Second panel" },
    bindTailnetPairing(),
  );
  expect(otherChanges).toBeGreaterThan(0);
  second();
  expect(currentTailnetPairing()).toBeNull();
  expect(await readTailnetAdminConfig(PERSONAL_TOMB)).toMatchObject({
    label: "Second panel",
  });
  stop = subscribeTailnetPairing(() => notifications++);
  await vi.waitFor(() =>
    expect(currentTailnetPairing()).toMatchObject({ label: "Second panel" }),
  );
});

it("refuses an old binding after the same owner authenticates again", async () => {
  await keepTailnetPairing(PAIRING, bindTailnetPairing());
  const stale = bindTailnetPairing();
  vaultStore.lock();
  await dropTailnetPairing(stale.revision);
  await vaultStore.unlockWithPin(PIN);
  await vi.waitFor(() => expect(currentTailnetPairing()).toEqual(PAIRING));
  await expect(
    keepTailnetPairing({ ...PAIRING, label: "Stale ceremony" }, stale),
  ).rejects.toMatchObject({ code: "target-changed" });
  expect(await readTailnetAdminConfig(PERSONAL_TOMB)).toEqual(PAIRING);
  await keepTailnetPairing(
    { ...PAIRING, label: "Fresh ceremony" },
    bindTailnetPairing(),
  );
  expect(currentTailnetPairing()?.label).toBe("Fresh ceremony");
});

it("withholds a pairing whose genuine seal finishes after its owner locks", async () => {
  await keepTailnetPairing(PAIRING, bindTailnetPairing());
  const ciphertext = kvGet(CONFIG);
  const seal = vfsSeams.seal;
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(vfsSeams, "seal").mockImplementation(async (key, value, binding) => {
    const sealed = await seal(key, value, binding);
    reached();
    await held;
    return sealed;
  });
  const pending = keepTailnetPairing(
    { ...PAIRING, token: "s".repeat(43) },
    bindTailnetPairing(),
  ).then(
    () => null,
    (error: Error) => error,
  );
  await started;
  vaultStore.lock();
  resume();
  expect(await pending).toBeInstanceOf(Error);
  expect(currentTailnetPairing()).toBeNull();
  expect(kvGet(CONFIG)).toBe(ciphertext);
  vi.restoreAllMocks();
  await vaultStore.unlockWithPin(PIN);
  await vi.waitFor(() => expect(currentTailnetPairing()).toEqual(PAIRING));
});
