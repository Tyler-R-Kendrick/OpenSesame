import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvGet } from "../kv.js";
import {
  BODY_PATH,
  INDEX_PATH,
  lockTomb,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { rekeyTomb } from "./seal-rebind.js";

const TOMB = "rekeytest";
const A = "settings/a";
const B = "settings/b";

async function freshKey() {
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  return { vaultKey, rawVaultKey };
}

function stored(path: string): string | null {
  return kvGet(tombFileKey(TOMB, path));
}

beforeEach(async () => {
  await vfsFlush();
  lockTomb(TOMB);
  for (const path of [A, B, INDEX_PATH, BODY_PATH]) {
    await vfsSeams.deleteRaw(tombFileKey(TOMB, path));
  }
});

describe("rekeying a tomb for a vault-key rotation", () => {
  it("re-seals every file and the index, then answers to the new key alone", async () => {
    const old = await freshKey();
    const next = await freshKey();
    unlockTomb(TOMB, old.vaultKey);
    await writeFile(TOMB, A, new Uint8Array([1, 2, 3]));
    await writeFile(TOMB, B, new Uint8Array([4, 5, 6]));
    const before = { a: stored(A), b: stored(B), index: stored(INDEX_PATH) };

    const key = await rekeyTomb(TOMB, old.vaultKey, next.rawVaultKey);

    expect(stored(A)).not.toBe(before.a);
    expect(stored(B)).not.toBe(before.b);
    expect(stored(INDEX_PATH)).not.toBe(before.index);
    // The tomb now answers to the new key: reads and listings open.
    expect(await readFile(TOMB, A)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readFile(TOMB, B)).toEqual(new Uint8Array([4, 5, 6]));
    // And a key that only knew the old seals opens nothing.
    lockTomb(TOMB);
    unlockTomb(TOMB, old.vaultKey);
    await expect(readFile(TOMB, A)).rejects.toThrow();
    unlockTomb(TOMB, key);
    expect(await readFile(TOMB, A)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("leaves the body to the store and touches no file that is not indexed", async () => {
    const old = await freshKey();
    const next = await freshKey();
    unlockTomb(TOMB, old.vaultKey);
    await writeFile(TOMB, A, new Uint8Array([9]));
    await vfsSeams.writeRaw(
      tombFileKey(TOMB, BODY_PATH),
      JSON.stringify({ ivB64: "aXY=", ctB64: "Ym9keQ==" }),
    );
    const body = stored(BODY_PATH);
    await rekeyTomb(TOMB, old.vaultKey, next.rawVaultKey);
    expect(stored(BODY_PATH)).toBe(body);
  });

  it("changes nothing when one file cannot be read, and keeps the old key", async () => {
    const old = await freshKey();
    const next = await freshKey();
    unlockTomb(TOMB, old.vaultKey);
    await writeFile(TOMB, A, new Uint8Array([1]));
    await writeFile(TOMB, B, new Uint8Array([2]));
    // B is still a sealed blob in shape, but not one the old key can open.
    await vfsSeams.writeRaw(
      tombFileKey(TOMB, B),
      JSON.stringify({ ivB64: "aXZpdml2aXZpdml2", ctB64: "bm90LXRoZS1rZXk=" }),
    );
    const before = { a: stored(A), b: stored(B), index: stored(INDEX_PATH) };

    await expect(
      rekeyTomb(TOMB, old.vaultKey, next.rawVaultKey),
    ).rejects.toThrow();

    expect({ a: stored(A), b: stored(B), index: stored(INDEX_PATH) }).toEqual(
      before,
    );
    // The session still answers to the key it had.
    expect(await readFile(TOMB, A)).toEqual(new Uint8Array([1]));
  });

  it("has nothing to re-seal in a tomb with no index, and still takes the new key", async () => {
    const old = await freshKey();
    const next = await freshKey();
    unlockTomb(TOMB, old.vaultKey);
    const key = await rekeyTomb(TOMB, old.vaultKey, next.rawVaultKey);
    expect(stored(INDEX_PATH)).toBeNull();
    await writeFile(TOMB, A, new Uint8Array([7]));
    expect(await readFile(TOMB, A)).toEqual(new Uint8Array([7]));
    lockTomb(TOMB);
    unlockTomb(TOMB, key);
    expect(await readFile(TOMB, A)).toEqual(new Uint8Array([7]));
  });
});
