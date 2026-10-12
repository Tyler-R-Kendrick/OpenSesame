/**
 * The pending store over the real VFS: a ceremony's secrets rest sealed under
 * the vault key (ADR 0149), the desk's colon-bearing keys survive the mapping
 * to a path, and a listing gives back the keys that were written.
 */
import { kvDelete, kvFileName, kvGet } from "@opensesame/app-core/lib/kv.js";
import { toHex } from "@opensesame/app-core/lib/quorum/bytes.js";
import type { Json } from "@opensesame/app-core/lib/quorum/canonical.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/ports.js";
import {
  INDEX_PATH,
  TOMBS_REGISTRY_KEY,
  VfsError,
  deleteFile,
  listDir,
  lockTomb,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PENDING_DIR, tombPendingStore } from "./pending-store.js";

const TOMB = "trusted-pending-test";
const SECRET = "c2VjcmV0LXNpZ25pbmcta2V5LW1hdGVyaWFsLTAwMDAwMQ";
// Long enough that a random base64 envelope cannot contain it by chance.
const NAME_MARKER = "Ada Lovelace the guardian of Family";

async function wipe(): Promise<void> {
  await vfsFlush();
  for (const path of await listDir(TOMB, "").catch(() => [])) {
    await deleteFile(TOMB, path);
  }
  kvDelete(tombFileKey(TOMB, INDEX_PATH));
  kvDelete(TOMBS_REGISTRY_KEY);
}

beforeEach(async () => {
  lockTomb(TOMB);
  unlockTomb(TOMB, (await mintVaultKey()).vaultKey);
  await wipe();
});

afterEach(async () => {
  await wipe();
  lockTomb(TOMB);
});

describe("tombPendingStore", () => {
  it("round-trips a value under a key with colons, and hands back a copy", async () => {
    const store = tombPendingStore(TOMB);
    const doc = { v: 1, ownerSecretKey: SECRET, guardians: [{ id: "g-ada" }] };
    await store.write("owner-draft:c-AbCd_12-34xy", doc);
    expect(await store.read("owner-draft:c-AbCd_12-34xy")).toEqual(doc);
    expect(await store.read("owner-draft:c-other")).toBeUndefined();
    await store.write("owner-draft:c-AbCd_12-34xy", { v: 2 });
    expect(await store.read("owner-draft:c-AbCd_12-34xy")).toEqual({ v: 2 });
  });

  it("keeps every kind of value plain JSON can hold", async () => {
    const store = tombPendingStore(TOMB);
    const cases: [string, Json][] = [
      ["cancelled:c-1", ["sha256:aa", "sha256:bb"]],
      ["ask:sha256:ab12", { snapshot: { counters: { g: 1 }, spent: [] } }],
      ["receipts:c-1", null],
      ["recovery:r-é-ü", "plain text"],
    ];
    for (const [key, value] of cases) {
      await store.write(key, value);
      expect(await store.read(key)).toEqual(value);
    }
  });

  it("lists the keys that start with a prefix, as they were written", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("guardian-pending:inv-2", 2);
    await store.write("guardian-pending:inv-1", 1);
    await store.write("ask:sha256:ff", 3);
    await store.write("owner-draft:c-1", 4);
    expect(await store.list("guardian-pending:")).toEqual([
      "guardian-pending:inv-1",
      "guardian-pending:inv-2",
    ]);
    expect(await store.list("ask:")).toEqual(["ask:sha256:ff"]);
    expect(await store.list("")).toHaveLength(4);
    expect(await store.list("recovery:")).toEqual([]);
  });

  it("ignores a file in its folder that it did not write, or that does not hold its own key", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("ask:sha256:ff", 1);
    await store.write("ask:sha256:ee", 2);
    const [first, second] = await listDir(TOMB, PENDING_DIR);
    if (!first || !second) throw new Error("nothing was written");
    const bytes = (text: string) => new TextEncoder().encode(text);
    await writeFile(TOMB, `${PENDING_DIR}/notes`, bytes("x"));
    await writeFile(TOMB, `${PENDING_DIR}/ZZ`, bytes("x"));
    // A name of the right shape holding something that is not a document.
    await writeFile(TOMB, `${PENDING_DIR}/${"a".repeat(64)}`, bytes("{half"));
    await writeFile(TOMB, `${PENDING_DIR}/${"b".repeat(64)}`, bytes("[1]"));
    // A document filed under a name that is not its key's.
    await writeFile(
      TOMB,
      `${PENDING_DIR}/${"c".repeat(64)}`,
      bytes('{"key":"ask:sha256:dd","value":3}'),
    );
    expect(await store.list("")).toEqual(["ask:sha256:ee", "ask:sha256:ff"]);
  });

  it("opens no more files than the cap when listing", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("ask:sha256:ff", 1);
    const opened: string[] = [];
    const original = vfsSeams.open;
    vfsSeams.open = (vaultKey, blob, binding) => {
      opened.push(binding ?? "");
      return original(vaultKey, blob, binding);
    };
    try {
      // 300 files of the right shape that are not documents.
      for (let n = 0; n < 300; n += 1) {
        const name = n.toString(16).padStart(64, "0");
        await writeFile(TOMB, `${PENDING_DIR}/${name}`, new Uint8Array([1]));
      }
      opened.length = 0;
      await store.list("");
    } finally {
      vfsSeams.open = original;
    }
    // One open for the sealed index, then at most 256 files.
    expect(opened.length).toBeLessThanOrEqual(257);
    expect(opened.length).toBeGreaterThan(200);
  });

  it("removes a key, and removing one that is not there is not an error", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", { epoch: 1 });
    await store.remove("receipts:c-1");
    expect(await store.read("receipts:c-1")).toBeUndefined();
    expect(await store.list("")).toEqual([]);
    await store.remove("receipts:c-1");
  });

  it("refuses a locked vault instead of answering as if nothing were saved", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", 1);
    lockTomb(TOMB);
    await expect(store.read("receipts:c-1")).rejects.toMatchObject({
      code: "locked",
    });
    await expect(store.list("")).rejects.toBeInstanceOf(VfsError);
    await expect(store.write("receipts:c-1", 2)).rejects.toBeInstanceOf(
      VfsError,
    );
  });

  it("keeps a long key, since no name carries it, and refuses an empty one", async () => {
    const store = tombPendingStore(TOMB);
    const long = `recovery:${"é".repeat(300)}`;
    await store.write(long, { v: 1 });
    expect(await store.read(long)).toEqual({ v: 1 });
    expect(await store.list("recovery:")).toEqual([long]);
    await expect(store.write("", 1)).rejects.toBeInstanceOf(DeskError);
    await expect(store.read("")).rejects.toBeInstanceOf(DeskError);
  });

  it("refuses a ceremony too large to keep", async () => {
    const store = tombPendingStore(TOMB);
    await expect(
      store.write("recovery:r-1", "x".repeat(16 * 1024 * 1024 + 1)),
    ).rejects.toBeInstanceOf(DeskError);
    expect(await store.read("recovery:r-1")).toBeUndefined();
  });

  it("sees what a second store over the same vault wrote, and the removals", async () => {
    const one = tombPendingStore(TOMB);
    const other = tombPendingStore(TOMB);
    await one.write("guardian-pending:inv-1", { n: 1 });
    expect(await other.read("guardian-pending:inv-1")).toEqual({ n: 1 });
    await other.write("guardian-pending:inv-2", { n: 2 });
    expect(await one.list("guardian-pending:")).toEqual([
      "guardian-pending:inv-1",
      "guardian-pending:inv-2",
    ]);
    await other.remove("guardian-pending:inv-1");
    expect(await one.read("guardian-pending:inv-1")).toBeUndefined();
    expect(await one.list("")).toEqual(["guardian-pending:inv-2"]);
  });

  it("names a saved ceremony that does not read, without quoting it", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", 1);
    const [path] = await listDir(TOMB, PENDING_DIR);
    if (!path) throw new Error("nothing was written");
    await writeFile(TOMB, path, new TextEncoder().encode(`{"half":${SECRET}`));
    const failure = await store.read("receipts:c-1").catch((error) => error);
    expect(failure).toBeInstanceOf(DeskError);
    expect(failure.code).toBe("stored");
    expect(failure.message).not.toContain(SECRET);
  });

  it("will not answer for a key from a document that holds another", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", 1);
    await store.write("receipts:c-2", 2);
    const docs = await Promise.all(
      (await listDir(TOMB, PENDING_DIR)).map(async (path) => ({
        path,
        text: new TextDecoder().decode(await readFile(TOMB, path)),
      })),
    );
    const one = docs.find((doc) => doc.text.includes("receipts:c-1"));
    const two = docs.find((doc) => doc.text.includes("receipts:c-2"));
    if (!one || !two) throw new Error("nothing was written");
    // The file named for c-1 now holds c-2's document.
    await writeFile(TOMB, one.path, new TextEncoder().encode(two.text));
    const failure = await store.read("receipts:c-1").catch((error) => error);
    expect(failure).toBeInstanceOf(DeskError);
    expect(failure.code).toBe("stored");
    expect(await store.list("")).toEqual(["receipts:c-2"]);
  });
});

describe("a ceremony at rest (ADR 0149, ADR 0175)", () => {
  const CIRCLE = "c-AbCd_12-34xy";

  it("writes nothing readable: not the key material, not the field names, not the key", async () => {
    const store = tombPendingStore(TOMB);
    const written: string[] = [];
    const named: string[] = [];
    const original = vfsSeams.writeRaw;
    vfsSeams.writeRaw = (key, value, vaultKey) => {
      written.push(value);
      named.push(key, kvFileName(key));
      return original(key, value, vaultKey);
    };
    try {
      await store.write(`owner-draft:${CIRCLE}`, {
        v: 1,
        circleId: CIRCLE,
        ownerSecretKey: SECRET,
      });
      await store.write("guardian-pending:inv-1", {
        hpkeSecretKey: SECRET,
        name: NAME_MARKER,
      });
      await store.write("recovery:r-9", { recipientSecretKey: SECRET });
      await vfsFlush();
    } finally {
      vfsSeams.writeRaw = original;
    }

    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const text of written) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("ownerSecretKey");
      expect(text).not.toContain("hpkeSecretKey");
      expect(text).not.toContain("owner-draft");
      expect(text).not.toContain(CIRCLE);
      expect(text).not.toContain(NAME_MARKER);
    }
    // What the storage layer holds for a file is the sealed envelope alone.
    const paths = await listDir(TOMB, PENDING_DIR);
    expect(paths).toHaveLength(3);
    for (const path of paths) {
      const raw = kvGet(tombFileKey(TOMB, path));
      expect(Object.keys(JSON.parse(raw ?? "{}")).sort()).toEqual(
        ["ctB64", "ivB64"].sort(),
      );
      expect(raw).not.toContain(SECRET);
    }
    // Nor does a file's name, in the VFS or on the origin, say what it is for.
    const names = [...named, ...paths, ...paths.map((p) => kvFileName(p))];
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      for (const word of [
        "owner-draft",
        "guardian-pending",
        "recovery",
        "inv-1",
        "r-9",
        CIRCLE,
        toHex(new TextEncoder().encode(`owner-draft:${CIRCLE}`)),
      ]) {
        expect(name).not.toContain(word);
      }
    }
    for (const path of paths) {
      expect(path.slice(PENDING_DIR.length + 1)).toMatch(/^[0-9a-f]{64}$/);
    }
    // The key is in the sealed document, and only there.
    const docs = await Promise.all(
      paths.map(async (path) =>
        JSON.parse(new TextDecoder().decode(await readFile(TOMB, path))),
      ),
    );
    expect(docs.map((doc) => doc.key).sort()).toEqual(
      [
        `owner-draft:${CIRCLE}`,
        "guardian-pending:inv-1",
        "recovery:r-9",
      ].sort(),
    );
    expect(kvGet(tombFileKey(TOMB, INDEX_PATH))).not.toContain("pending");
  });

  it("opens only under the vault key it was sealed with", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", { epoch: 1 });
    unlockTomb(TOMB, (await mintVaultKey()).vaultKey);
    await expect(store.read("receipts:c-1")).rejects.toThrow();
  });
});
