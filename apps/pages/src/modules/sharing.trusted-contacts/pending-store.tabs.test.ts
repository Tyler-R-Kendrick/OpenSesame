/**
 * A ceremony another tab moved on. With the origin's files durable the store
 * reads the file as the origin has it before it answers, so a second tab does
 * not act on what this one last saw. The origin's files are a small in-memory
 * stand-in for OPFS; the VFS and the store are the real ones.
 */
import {
  kvDelete,
  kvDurability,
  kvFileName,
  kvFlush,
} from "@opensesame/app-core/lib/kv.js";
import {
  INDEX_PATH,
  TOMBS_REGISTRY_KEY,
  deleteFile,
  listDir,
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_DIR, tombPendingStore } from "./pending-store.js";

const TOMB = "trusted-pending-tabs";

/** Just enough of an origin file system: named files with text. */
function originFiles() {
  const files = new Map<string, string>();
  return {
    files,
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("none", "NotFoundError");
        files.set(name, "");
      }
      return {
        async getFile() {
          const text = files.get(name) ?? "";
          return {
            size: new TextEncoder().encode(text).length,
            text: async () => text,
          };
        },
        async createWritable() {
          let staged = "";
          return {
            write: async (value: string) => {
              staged = value;
            },
            close: async () => {
              files.set(name, staged);
            },
            abort: async () => undefined,
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException("none", "NotFoundError");
    },
  };
}

let root: ReturnType<typeof originFiles>;

async function wipe(): Promise<void> {
  await vfsFlush();
  await kvFlush();
  for (const path of await listDir(TOMB, "").catch(() => [])) {
    await deleteFile(TOMB, path);
  }
  kvDelete(tombFileKey(TOMB, INDEX_PATH));
  kvDelete(TOMBS_REGISTRY_KEY);
}

beforeEach(async () => {
  root = originFiles();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(root) },
  });
  lockTomb(TOMB);
  unlockTomb(TOMB, (await mintVaultKey()).vaultKey);
  await wipe();
});

afterEach(async () => {
  await wipe();
  lockTomb(TOMB);
  vi.unstubAllGlobals();
});

/** The origin file a key is kept in: named by the hash of the key. */
async function fileOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  const name = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return kvFileName(tombFileKey(TOMB, `${PENDING_DIR}/${name}`));
}

describe("tombPendingStore beside another tab", () => {
  it("answers from the origin's file, not from the copy this tab last held", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("ask:sha256:aa", { turn: 1 });
    expect(kvDurability()).toBe("persistent");
    const first = root.files.get(await fileOf("ask:sha256:aa"));
    await store.write("ask:sha256:aa", { turn: 2 });
    expect(await store.read("ask:sha256:aa")).toEqual({ turn: 2 });

    // The other tab's write is the older sealed text, whatever it was.
    root.files.set(await fileOf("ask:sha256:aa"), first ?? "");
    expect(await store.read("ask:sha256:aa")).toEqual({ turn: 1 });
  });

  it("finds a ceremony removed from under it as gone", async () => {
    const store = tombPendingStore(TOMB);
    await store.write("receipts:c-1", 1);
    await store.write("receipts:c-2", 2);
    root.files.delete(await fileOf("receipts:c-1"));
    expect(await store.read("receipts:c-1")).toBeUndefined();
    expect(await store.read("receipts:c-2")).toBe(2);
  });

  it("lists what the origin's index says, not what this tab last saw", async () => {
    const store = tombPendingStore(TOMB);
    const index = kvFileName(tombFileKey(TOMB, INDEX_PATH));
    await store.write("receipts:c-1", 1);
    const before = root.files.get(index);
    await store.write("receipts:c-2", 2);
    expect(await store.list("receipts:")).toEqual([
      "receipts:c-1",
      "receipts:c-2",
    ]);
    // The other tab never wrote c-2.
    root.files.set(index, before ?? "");
    expect(await store.list("receipts:")).toEqual(["receipts:c-1"]);
  });
});
