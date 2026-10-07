import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_DROP_CIPHERTEXT_BYTES,
  openDrop,
  sealDrop,
} from "./drop-format.js";

describe("secret drop encrypted interchange", () => {
  it("roundtrips Unicode text with independent fresh keys and fragment-only key material", async () => {
    const payload = {
      kind: "text",
      name: "fixture.txt",
      text: "fixture 🔐 café",
    } as const;
    const first = await sealDrop(payload);
    const second = await sealDrop(payload);
    expect(await openDrop(first.manifest, first.fragmentKey)).toEqual(payload);
    expect(first.fragmentKey).not.toBe(second.fragmentKey);
    expect(first.manifest.ciphertext).not.toBe(second.manifest.ciphertext);
    expect(JSON.stringify(first.manifest)).not.toContain(first.fragmentKey);
    expect(Buffer.from(first.fragmentKey, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.manifest.nonce, "base64")).toHaveLength(12);
    await expect(
      openDrop(first.manifest, second.fragmentKey),
    ).rejects.toMatchObject({ code: "tampered" });
  });

  it("opens binary files and verifies platform SHA-256 digests", async () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 256);
    const sealed = await sealDrop({
      kind: "file",
      name: "fixture.bin",
      contentType: "",
      bytes,
    });
    expect(await openDrop(sealed.manifest, sealed.fragmentKey)).toEqual({
      kind: "file",
      name: "fixture.bin",
      contentType: "application/octet-stream",
      bytes,
    });
    const digest = createHash("sha256").update(bytes).digest("base64");
    expect(sealed.manifest.digest).toBe(digest);
    expect(sealed.manifest.chunks?.[0]?.digest).toBe(digest);
    expect(sealed.manifest.ciphertext).toBe("");
    await expect(
      openDrop(
        { ...sealed.manifest, digest: Buffer.alloc(32).toString("base64") },
        sealed.fragmentKey,
      ),
    ).rejects.toMatchObject({ code: "tampered" });
    const chunks = sealed.manifest.chunks?.map((chunk) => ({
      ...chunk,
      digest: Buffer.alloc(32).toString("base64"),
    }));
    await expect(
      openDrop({ ...sealed.manifest, chunks }, sealed.fragmentKey),
    ).rejects.toMatchObject({ code: "tampered" });
  });

  it("refuses changed ciphertext and nonces before returning plaintext", async () => {
    const sealed = await sealDrop({
      kind: "text",
      name: "fixture",
      text: "private fixture",
    });
    const ciphertext = Buffer.from(sealed.manifest.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await expect(
      openDrop(
        { ...sealed.manifest, ciphertext: ciphertext.toString("base64") },
        sealed.fragmentKey,
      ),
    ).rejects.toMatchObject({ code: "tampered" });
    await expect(
      openDrop(
        { ...sealed.manifest, nonce: Buffer.alloc(12).toString("base64") },
        sealed.fragmentKey,
      ),
    ).rejects.toMatchObject({ code: "tampered" });
  });

  it.each(["", "%%%", Buffer.alloc(31).toString("base64url")])(
    "refuses malformed or wrong-length fragment keys",
    async (key) => {
      const sealed = await sealDrop({
        kind: "text",
        name: "fixture",
        text: "",
      });
      await expect(openDrop(sealed.manifest, key)).rejects.toMatchObject({
        code: "invalid_key",
      });
    },
  );

  it.each([
    null,
    [],
    {},
    { kind: "other" },
    {
      kind: "secret-drop",
      name: "f",
      contentType: "binary",
      nonce: "",
      ciphertext: "",
      chunks: [null],
      digest: "",
    },
    {
      kind: "secret-drop",
      name: "f",
      contentType: "binary",
      nonce: "",
      ciphertext: "",
      chunks: [{ nonce: 7, ciphertext: "", digest: "" }],
      digest: "",
    },
    {
      kind: "secret-drop",
      name: 7,
      contentType: "text/plain",
      nonce: "",
      ciphertext: "",
    },
    {
      kind: "secret-drop",
      name: "f",
      contentType: "binary",
      nonce: "",
      ciphertext: "",
      chunks: [],
    },
    {
      kind: "secret-drop",
      name: "f",
      contentType: "binary",
      nonce: "",
      ciphertext: "",
      chunks: [{ nonce: "", ciphertext: "", digest: "" }],
    },
  ])("rejects invalid manifest shapes", async (manifest) => {
    await expect(openDrop(manifest, "")).rejects.toMatchObject({
      code: "invalid_manifest",
    });
  });

  it("enforces the ciphertext cap including the AES authentication tag", async () => {
    const text = "x".repeat(MAX_DROP_CIPHERTEXT_BYTES - 16);
    const sealed = await sealDrop({ kind: "text", name: "max", text });
    expect(Buffer.from(sealed.manifest.ciphertext, "base64")).toHaveLength(
      MAX_DROP_CIPHERTEXT_BYTES,
    );
    expect(await openDrop(sealed.manifest, sealed.fragmentKey)).toEqual({
      kind: "text",
      name: "max",
      text,
    });
    await expect(
      sealDrop({ kind: "text", name: "too-large", text: `${text}x` }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    await expect(
      sealDrop({
        kind: "file",
        name: "empty",
        contentType: "binary",
        bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    await expect(
      sealDrop({
        kind: "file",
        name: "too-large",
        contentType: "binary",
        bytes: new Uint8Array(MAX_DROP_CIPHERTEXT_BYTES),
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    await expect(
      openDrop(
        {
          ...sealed.manifest,
          ciphertext: Buffer.alloc(MAX_DROP_CIPHERTEXT_BYTES + 1).toString(
            "base64",
          ),
        },
        sealed.fragmentKey,
      ),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });
});
