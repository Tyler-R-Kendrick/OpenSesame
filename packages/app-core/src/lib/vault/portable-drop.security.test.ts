import { isJsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePortableDropPacket } from "./portable-drop-crypto.js";
import {
  MAX_CODE_CIPHERTEXT_CHARS,
  MAX_PORTABLE_MANIFEST_BYTES,
  MAX_PORTABLE_PACKET_CHARS,
} from "./portable-drop-limits.js";
import {
  buildPortableDropBundle,
  openPortableDropBundle,
} from "./portable-drop.js";
import { rewritePortableEnvelope } from "./portable-drop.test-support.js";

const CODE = "ABCD-EFGH";
const MANIFEST = { kind: "secret-drop", ciphertext: "fixture" };

afterEach(() => vi.restoreAllMocks());

describe("portable packet admission", () => {
  it("rejects oversized input before crypto or packet decoding", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await expect(
      decodePortableDropPacket(
        "A".repeat(MAX_PORTABLE_PACKET_CHARS + 1),
        "bad-token",
      ),
    ).rejects.toMatchObject({ code: "tampered" });
    expect(derive).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("refuses an oversized writer manifest before deriving its code key", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    await expect(
      buildPortableDropBundle(
        { ciphertext: "A".repeat(MAX_PORTABLE_MANIFEST_BYTES) },
        60_000,
        CODE,
      ),
    ).rejects.toThrow(/too large/);
    expect(derive).not.toHaveBeenCalled();
  });

  it.each([0, 1, 600_001, 1e100, "600000", null])(
    "refuses authenticated hostile KDF iteration metadata %s",
    async (iterations) => {
      const sealed = await buildPortableDropBundle(MANIFEST, 60_000, CODE);
      const packet = await rewritePortableEnvelope(
        sealed.pkt,
        sealed.bearerToken,
        (root) => {
          if (!isJsonObject(root.codeKdf))
            throw new Error("missing fixture KDF");
          root.codeKdf.iterations = iterations;
        },
      );
      await expect(
        openPortableDropBundle(packet, sealed.bearerToken, CODE),
      ).rejects.toMatchObject({ code: "tampered" });
    },
  );

  it("rejects authenticated oversized inner ciphertext before attempting the code KDF", async () => {
    const sealed = await buildPortableDropBundle(MANIFEST, 60_000, CODE);
    const packet = await rewritePortableEnvelope(
      sealed.pkt,
      sealed.bearerToken,
      (root) => {
        if (!isJsonObject(root.sealedManifest))
          throw new Error("missing fixture manifest");
        root.sealedManifest.ciphertext = "A".repeat(
          MAX_CODE_CIPHERTEXT_CHARS + 1,
        );
      },
    );
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    await expect(
      openPortableDropBundle(packet, sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "tampered" });
    expect(derive).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "PBKDF2" }),
      expect.anything(),
      expect.anything(),
      false,
      expect.anything(),
    );
  });
});
