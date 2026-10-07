import { parseTotp, totpCode } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { kvForgetAll } from "../kv.js";
import { vfsFlush } from "../vfs.js";
import * as protector from "./protector-unlock-session.js";
import { VaultStore } from "./store.js";

const PASSWORD = "actual held recovery root owner";
const stores: VaultStore[] = [];
type ReturnedRecoveryRoot = { root: ArrayBuffer | null };
beforeEach(async () => {
  await vfsFlush();
  kvForgetAll();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});
afterEach(() => {
  for (const store of stores.splice(0)) store.lock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function newStore() {
  const store = new VaultStore();
  stores.push(store);
  return store;
}
async function ownerWithRecovery() {
  const owner = newStore();
  await owner.create(PASSWORD);
  const candidate = await owner.protection.enrollCandidate("recovery-key");
  await owner.protection.commitEnrollment(candidate.operationId);
  if (!candidate.recoverySecretB64)
    throw new Error("Expected actual recovery secret");
  owner.lock();
  return { owner, secret: candidate.recoverySecretB64 };
}
async function peerAddsTotp() {
  const peer = newStore();
  await peer.unlock(PASSWORD);
  const uri = await peer.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("Expected genuine TOTP enrollment");
  await peer.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  expect(peer.getSnapshot().header?.unlocks?.totp).toBeDefined();
  return peer;
}

it("wipes a returned genuine recovery root after peer TOTP enrollment and refuses its real admission", async () => {
  const { owner, secret } = await ownerWithRecovery();
  const root = await owner.probeProtector({ method: "recovery", secret });
  expect(new Uint8Array(root).some((byte) => byte !== 0)).toBe(true);
  const peer = await peerAddsTotp();
  await expect(
    owner.unlockWithHeldProtectorRoot(root, { method: "recovery" }),
  ).rejects.toThrow(/authentication changed/);
  expect(new Uint8Array(root).every((byte) => byte === 0)).toBe(true);
  expect(owner.isUnlocked()).toBe(false);
  expect(owner.getSnapshot().items).toEqual([]);
  expect(peer.isUnlocked()).toBe(true);
});

it("wipes a genuine recovery probe completed after peer TOTP enrollment without returning its raw root", async () => {
  const { owner, secret } = await ownerWithRecovery();
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: ReturnedRecoveryRoot = { root: null };
  const actual = protector.probeProtectorRoot;
  vi.spyOn(protector, "probeProtectorRoot").mockImplementationOnce(
    async (...args) => {
      const root = await actual(...args);
      observed.root = root;
      reached();
      await blocked;
      return root;
    },
  );
  const result = owner.probeProtector({ method: "recovery", secret }).then(
    () => null,
    (error: Error) => error,
  );
  try {
    await started;
    const peer = await peerAddsTotp();
    release();
    expect(await result).toBeInstanceOf(Error);
    if (!observed.root)
      throw new Error("Expected actual decrypted recovery root");
    expect(new Uint8Array(observed.root).every((byte) => byte === 0)).toBe(
      true,
    );
    expect(owner.isUnlocked()).toBe(false);
    expect(owner.getSnapshot().items).toEqual([]);
    expect(peer.isUnlocked()).toBe(true);
  } finally {
    release();
    await result;
  }
});
