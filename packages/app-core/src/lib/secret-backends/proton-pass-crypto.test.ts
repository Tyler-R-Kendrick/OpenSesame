import { createCipheriv, createDecipheriv } from "node:crypto";
import * as gcm from "@opensesame/vault-core/gcm.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProtonEncryptionTag,
  importProtonKey,
  openProtonValue,
  sealProtonValue,
} from "./proton-pass-crypto.js";
import { PROTON_ITEM_MAX_BYTES } from "./proton-pass-wire.js";

const raw = Uint8Array.from({ length: 32 }, (_, index) => index);
const plain = new TextEncoder().encode("public synthetic plaintext");
const tags: ProtonEncryptionTag[] = [
  "sharekey",
  "itemkey",
  "itemcontent",
  "vaultcontent",
  "folderkey",
  "foldercontent",
];
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
});

function owner() {
  const controller = new AbortController();
  return { controller, signal: controller.signal, assertCurrent: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function independent(tag: string, data = plain, key = raw): string {
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 64);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(tag));
  return Buffer.concat([
    iv,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function independentOpen(value: string, tag: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", raw, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(tag));
  decipher.setAuthTag(bytes.subarray(-16));
  return new Uint8Array(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
}

describe("Proton direct owned AES-GCM values", () => {
  it.each(tags)(
    "opens independent node:crypto %s data and seals interoperable output",
    async (tag) => {
      const held = owner();
      const key = await importProtonKey(raw, held);
      expect(key.extractable).toBe(false);
      expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
      expect(await openProtonValue(independent(tag), key, tag, held)).toEqual(
        plain,
      );
      const sealed = await sealProtonValue(plain, key, tag, held);
      expect(independentOpen(sealed, tag)).toEqual(plain);
      expect(raw).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));
      expect(plain).toEqual(
        new TextEncoder().encode("public synthetic plaintext"),
      );
    },
  );

  it.each(["folderkey", "foldercontent"] as const)(
    "binds %s to its exact folder domain",
    async (tag) => {
      const held = owner();
      const key = await importProtonKey(raw, held);
      const wrong = tag === "folderkey" ? "itemkey" : "vaultcontent";
      await expect(
        openProtonValue(independent(tag), key, wrong, held),
      ).rejects.toMatchObject({ code: "authentication" });
      const altered = Buffer.from(independent(tag), "base64");
      altered[altered.length - 1] ^= 1;
      await expect(
        openProtonValue(altered.toString("base64"), key, tag, held),
      ).rejects.toMatchObject({ code: "authentication" });
    },
  );

  it("uses fresh nonces for distinct actual writes", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    const first = await sealProtonValue(plain, key, "itemcontent", held);
    const second = await sealProtonValue(plain, key, "itemcontent", held);
    expect(Buffer.from(first, "base64").subarray(0, 12)).not.toEqual(
      Buffer.from(second, "base64").subarray(0, 12),
    );
    expect(independentOpen(first, "itemcontent")).toEqual(plain);
    expect(independentOpen(second, "itemcontent")).toEqual(plain);
  });

  it("opens an independent PAT to share to item key chain with exact protocol AAD", async () => {
    const held = owner();
    const share = Uint8Array.from({ length: 32 }, (_, index) => index + 32);
    const item = Uint8Array.from({ length: 32 }, (_, index) => index + 64);
    const patKey = await importProtonKey(raw, held);
    const openedShare = await openProtonValue(
      independent("sharekey", share),
      patKey,
      "sharekey",
      held,
    );
    let openedItem: Uint8Array | undefined;
    try {
      const shareKey = await importProtonKey(openedShare, held);
      openedItem = await openProtonValue(
        independent("itemkey", item, share),
        shareKey,
        "itemkey",
        held,
      );
      const itemKey = await importProtonKey(openedItem, held);
      expect(
        await openProtonValue(
          independent("itemcontent", plain, item),
          itemKey,
          "itemcontent",
          held,
        ),
      ).toEqual(plain);
    } finally {
      openedShare.fill(0);
      openedItem?.fill(0);
    }
  });

  it("fences a real key import completed after withdrawal and wipes its temporary key bytes", async () => {
    const held = owner();
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    const reached = deferred<Uint8Array>();
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        const data = args[1];
        const temporary = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        reached.resolve(temporary);
        await gate.promise;
        return result;
      },
    );
    const pending = importProtonKey(raw, held);
    const temporary = await reached.promise;
    expect(temporary).toEqual(raw);
    held.controller.abort();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(temporary).toEqual(new Uint8Array(32));
    expect(raw).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));
  });

  it.each(["key", "aad", "nonce", "tag"])(
    "refuses authenticated %s tampering",
    async (mode) => {
      const held = owner();
      const keyBytes = mode === "key" ? new Uint8Array(32).fill(9) : raw;
      const key = await importProtonKey(keyBytes, held);
      const body = Buffer.from(independent("itemcontent"), "base64");
      if (mode === "nonce") body[0] ^= 1;
      if (mode === "tag") body[body.length - 1] ^= 1;
      await expect(
        openProtonValue(
          body.toString("base64"),
          key,
          mode === "aad" ? "itemkey" : "itemcontent",
          held,
        ),
      ).rejects.toMatchObject({ code: "authentication" });
    },
  );

  it.each([0, 16, 24, 31, 33])(
    "refuses raw key length %s without crypto import",
    async (size) => {
      const imported = vi.spyOn(crypto.subtle, "importKey");
      await expect(
        importProtonKey(new Uint8Array(size), owner()),
      ).rejects.toMatchObject({ code: "configuration" });
      expect(imported).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "AA", "AA=", "AA===", "AA==\n", "AA-A", "AA_A", "!!!!"])(
    "refuses malformed or short base64 %# before decrypt",
    async (value) => {
      const held = owner();
      const key = await importProtonKey(raw, held);
      const decrypt = vi.spyOn(gcm, "gcmOpen");
      await expect(
        openProtonValue(value, key, "itemcontent", held),
      ).rejects.toMatchObject({ code: "format" });
      expect(decrypt).not.toHaveBeenCalled();
    },
  );

  it("refuses noncanonical unused base64 bits even when decoded bytes authenticate", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    const original = independent("itemcontent", new Uint8Array(1));
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const index = original.length - 2;
    const changed = `${original.slice(0, index)}${alphabet[alphabet.indexOf(original[index] ?? "") ^ 1]}=`;
    expect(Buffer.from(changed, "base64")).toEqual(
      Buffer.from(original, "base64"),
    );
    await expect(
      openProtonValue(changed, key, "itemcontent", held),
    ).rejects.toMatchObject({ code: "format" });
  });

  it("rejects oversized values before decode/encrypt and supports the exact bound", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    await expect(
      openProtonValue(
        "A".repeat(4 * Math.ceil((PROTON_ITEM_MAX_BYTES + 28) / 3) + 4),
        key,
        "itemcontent",
        held,
      ),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      sealProtonValue(
        new Uint8Array(PROTON_ITEM_MAX_BYTES + 1),
        key,
        "itemcontent",
        held,
      ),
    ).rejects.toMatchObject({ code: "limit" });
    const data = new Uint8Array(PROTON_ITEM_MAX_BYTES).fill(83);
    const sealed = await sealProtonValue(data, key, "itemcontent", held);
    expect(independentOpen(sealed, "itemcontent")).toEqual(data);
    expect(await openProtonValue(sealed, key, "itemcontent", held)).toEqual(
      data,
    );
  });

  it("does not expose a real decrypted result after owner withdrawal and wipes it", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    const original = gcm.gcmOpen;
    const reached = deferred<Uint8Array>();
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    vi.spyOn(gcm, "gcmOpen").mockImplementation(async (...args) => {
      const result = await original(...args);
      reached.resolve(result);
      await gate.promise;
      return result;
    });
    const pending = openProtonValue(
      independent("itemcontent"),
      key,
      "itemcontent",
      held,
    );
    const result = await reached.promise;
    expect(result).toEqual(plain);
    held.controller.abort();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(result).toEqual(new Uint8Array(plain.length));
  });

  it("rejects a late seal and wipes its owned plaintext without changing the input", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    const original = gcm.gcmSeal;
    const reached = deferred<Uint8Array>();
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    vi.spyOn(gcm, "gcmSeal").mockImplementation(async (...args) => {
      const result = await original(...args);
      reached.resolve(args[1]);
      await gate.promise;
      return result;
    });
    const pending = sealProtonValue(plain, key, "itemcontent", held);
    const temporary = await reached.promise;
    expect(temporary).toEqual(plain);
    held.controller.abort();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(temporary).toEqual(new Uint8Array(plain.length));
    expect(plain).toEqual(
      new TextEncoder().encode("public synthetic plaintext"),
    );
  });

  it("preserves the original vault/capability owner check error", async () => {
    const held = owner();
    const error = new Error("original owner ended");
    held.assertCurrent.mockImplementation(() => {
      throw error;
    });
    await expect(importProtonKey(raw, held)).rejects.toBe(error);
  });

  it("refuses unknown protocol tags and an extractable key", async () => {
    const held = owner();
    const key = await importProtonKey(raw, held);
    // SAFETY: Invalid synthetic input is confined to this negative test and verifies runtime rejection; it grants no authority.
    const invalidTag = "wrong" as ProtonEncryptionTag;
    await expect(
      sealProtonValue(plain, key, invalidTag, held),
    ).rejects.toMatchObject({
      code: "configuration",
    });
    const extractable = await crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
    await expect(
      openProtonValue(
        independent("itemcontent"),
        extractable,
        "itemcontent",
        held,
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  });
});
