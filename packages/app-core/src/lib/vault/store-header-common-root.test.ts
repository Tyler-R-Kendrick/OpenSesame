import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { markDecoySession } from "../decoy-session.js";
import { kvForgetAll } from "../kv.js";
import {
  HEADER_PATH,
  readPlaintextFile,
  unlockTomb,
  vfsFlush,
} from "../vfs.js";
import { VaultStore } from "./store.js";

const stores: VaultStore[] = [];
beforeEach(async () => {
  await vfsFlush();
  kvForgetAll();
});
afterEach(() => {
  for (const store of stores.splice(0)) store.lock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function owners() {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  const password = "genuine current owner common root policy";
  const owner = new VaultStore();
  stores.push(owner);
  await owner.create(password);
  owner.lock();
  await owner.unlock(password);
  const peer = new VaultStore();
  stores.push(peer);
  peer.rehydrate();
  await peer.unlock(password);
  const tomb = owner.getSnapshot().tomb;
  const header = readPlaintextFile(tomb, HEADER_PATH);
  return { owner, peer, tomb, header };
}

it("allows an authenticated owner to enroll a PIN while an independent same-root store holds the current VFS key", async () => {
  const { owner, peer } = await owners();
  await owner.enrollPin("48291573");
  owner.lock();
  await owner.unlockWithPin("48291573");
  expect(owner.getSnapshot().status).toBe("unlocked");
  expect(peer.getSnapshot().status).toBe("unlocked");
});

it("refuses a current-looking storage admission holding an actual different root without changing the owner's policy", async () => {
  const { owner, tomb, header } = await owners();
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  await expect(owner.enrollPin("48291573")).rejects.toThrow();
  expect(readPlaintextFile(tomb, HEADER_PATH)).toBe(header);
  expect(owner.getSnapshot().header?.unlocks?.pin).toBeUndefined();
});

it.each(["map", "realm"] as const)(
  "withholds a pending genuine common-root policy commit after %s changes and wipes its original raw copy",
  async (change) => {
    const { owner, tomb, header } = await owners();
    const successor = (await mintVaultKey()).vaultKey;
    let reached = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rawCopies: Uint8Array[] = [];
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
      if (
        args[0] === "raw" &&
        args[2] === "HKDF" &&
        args[1] instanceof Uint8Array
      )
        rawCopies.push(args[1]);
      return importKey(...args);
    });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
      const tag = await sign(...args);
      reached();
      await blocked;
      return tag;
    });
    const result = owner.enrollPin("48291573").then(
      () => null,
      (error: Error) => error,
    );
    await started;
    if (change === "map") unlockTomb(tomb, successor);
    if (change === "realm") {
      markDecoySession(true, tomb);
      markDecoySession(false);
    }
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(readPlaintextFile(tomb, HEADER_PATH)).toBe(header);
    expect(rawCopies.length).toBeGreaterThan(0);
    expect(rawCopies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(
      true,
    );
  },
);
