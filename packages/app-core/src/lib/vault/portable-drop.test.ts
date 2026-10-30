// @vitest-environment jsdom
import {
  PORTABLE_DROP_TOKEN_PREFIX as KIT_PREFIX,
  isPortableDropToken as kitIsPortableDropToken,
} from "@opensesame/ceremony-kit";
import { b64urlToBytes } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDrop, sealDrop } from "./drop.js";
import {
  decodePortableDropPacket,
  openPortableDropManifest,
} from "./portable-drop-crypto.js";
import {
  PORTABLE_DROP_TOKEN_PREFIX,
  buildPortableDropBundle,
  createPortableDropSession,
  isPortableDropToken,
  openPortableDropBundle,
  portableDropLink,
  resetPortableDropAttemptsForTests,
} from "./portable-drop.js";

const TEXT = { kind: "text" as const, name: "Deploy token", text: "s3cr3t" };
const CODE = "ABCD-EFGH";
const CODE_KDF = "PBKDF2-SHA256";
const CODE_KDF_ITERATIONS = 600_000;

async function bundle(ttlMs = 600_000) {
  const { manifest } = await sealDrop(TEXT);
  return {
    manifest,
    sealed: await buildPortableDropBundle(manifest, ttlMs, CODE),
  };
}

function flipFirst(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  resetPortableDropAttemptsForTests();
});

describe("portable drop bundles", () => {
  it("mints 80-bit session codes in four groups from the unambiguous base32 alphabet", async () => {
    const { manifest } = await sealDrop(TEXT);
    const session = await createPortableDropSession(
      manifest,
      600_000,
      "https://example.test/verify",
    );
    expect(session.userCode).toMatch(
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/,
    );
  });

  it("round-trips a manifest only with the bearer and user code", async () => {
    const { manifest, sealed } = await bundle();
    expect(sealed.pkt).not.toContain(manifest.ciphertext);
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, CODE),
    ).resolves.toEqual(manifest);
  });

  it("mints a 32-byte bearer secret and a fresh token every time", async () => {
    const first = await bundle();
    const second = await bundle();
    expect(first.sealed.bearerToken).not.toBe(second.sealed.bearerToken);
    expect(isPortableDropToken(first.sealed.bearerToken)).toBe(true);
    expect(
      first.sealed.bearerToken.startsWith(PORTABLE_DROP_TOKEN_PREFIX),
    ).toBe(true);
    const secret = first.sealed.bearerToken.split(".")[1] ?? "";
    expect(b64urlToBytes(secret)).toHaveLength(32);
    expect(isPortableDropToken("osc_clm_a.b")).toBe(false);
    expect(isPortableDropToken("osc_pdrop_short.secret")).toBe(false);
    expect(KIT_PREFIX).toBe(PORTABLE_DROP_TOKEN_PREFIX);
    expect(kitIsPortableDropToken(first.sealed.bearerToken)).toBe(true);
    expect(kitIsPortableDropToken("osc_clm_a.b")).toBe(
      isPortableDropToken("osc_clm_a.b"),
    );
  });

  it("puts the bearer, drop key and packet in the fragment only", () => {
    const link = portableDropLink(
      "https://pages.example/OpenSesame/claim",
      `osc_pdrop_${"A".repeat(22)}.${"B".repeat(43)}`,
      "drop-key_-",
      "ospd1.packet",
    );
    const url = new URL(link);
    expect(url.search).toBe("");
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get("token")).toBe(
      `osc_pdrop_${"A".repeat(22)}.${"B".repeat(43)}`,
    );
    expect(params.get("key")).toBe("drop-key_-");
    expect(params.get("pkt")).toBe("ospd1.packet");
  });

  it("refuses a wrong code without spending later tries", async () => {
    const { manifest, sealed } = await bundle();
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, "WRONG-CODE"),
    ).rejects.toMatchObject({
      code: "invalid_code",
      attemptsLeft: 4,
      message: "That code does not match this drop. 4 tries left.",
    });
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, CODE),
    ).resolves.toEqual(manifest);
  });

  it("locks this recipient out after the local drop attempt ceiling", async () => {
    const { sealed } = await bundle();
    for (const attemptsLeft of [4, 3, 2, 1]) {
      await expect(
        openPortableDropBundle(sealed.pkt, sealed.bearerToken, "WRONG-CODE"),
      ).rejects.toMatchObject({ code: "invalid_code", attemptsLeft });
    }
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, "WRONG-CODE"),
    ).rejects.toMatchObject({
      code: "locked_out",
      message:
        "Locked out. Too many wrong codes — ask the sender for a fresh drop.",
    });
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "locked_out" });
  });

  it("retains the local attempt count when storage accepts reads but rejects writes", async () => {
    const { sealed } = await bundle();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    for (let remaining = 4; remaining > 0; remaining--) {
      await expect(
        openPortableDropBundle(sealed.pkt, sealed.bearerToken, "WRONG-CODE"),
      ).rejects.toMatchObject({
        code: "invalid_code",
        attemptsLeft: remaining,
      });
    }
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, "WRONG-CODE"),
    ).rejects.toMatchObject({ code: "locked_out" });
  });

  it("checks expiry from the sealed timestamp", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { sealed } = await bundle(1_000);
    clock.mockReturnValue(1_001_001);
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("refuses another bearer as invalid_token", async () => {
    const { sealed } = await bundle();
    const other = await bundle();
    await expect(
      openPortableDropBundle(sealed.pkt, other.sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      openPortableDropBundle(sealed.pkt, "osc_pdrop_short.secret", CODE),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("keeps the manifest encrypted after a link holder opens the bearer envelope", async () => {
    const { manifest, fragmentKey } = await sealDrop(TEXT);
    const sealed = await buildPortableDropBundle(manifest, 600_000, CODE);
    const decoded = await decodePortableDropPacket(
      sealed.pkt,
      sealed.bearerToken,
    );
    expect(decoded).not.toHaveProperty("manifest");
    expect(decoded).not.toHaveProperty("userCodeDigest");
    expect(JSON.stringify(decoded)).not.toContain(manifest.ciphertext);
    await expect(
      openDrop(decoded.sealedManifest, fragmentKey),
    ).rejects.toThrow();
    // This bypasses the normal opener and its local counter entirely.
    await expect(
      openPortableDropManifest(decoded, "WRONG-CODE"),
    ).resolves.toBeNull();
    const opened = await openPortableDropManifest(decoded, CODE);
    await expect(openDrop(opened, fragmentKey)).resolves.toMatchObject(TEXT);
  });

  it("derives the code encryption key with 600000 PBKDF2-SHA256 rounds and trims the code", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const { manifest } = await sealDrop(TEXT);
    const sealed = await buildPortableDropBundle(
      manifest,
      600_000,
      `  ${CODE}  `,
    );
    const decoded = await decodePortableDropPacket(
      sealed.pkt,
      sealed.bearerToken,
    );
    expect(decoded.claimId).toBe(sealed.claimId);
    expect(decoded.codeKdf.algorithm).toBe(CODE_KDF);
    expect(decoded.codeKdf.iterations).toBe(CODE_KDF_ITERATIONS);
    expect(decoded.codeSalt).toHaveLength(16);
    expect(derive).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: CODE_KDF_ITERATIONS,
      }),
      expect.anything(),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await expect(
      openPortableDropBundle(sealed.pkt, sealed.bearerToken, ` ${CODE}`),
    ).resolves.toEqual(manifest);
  });

  it("refuses legacy packets instead of falling back to a code-free manifest", async () => {
    const { sealed } = await bundle();
    const legacy = sealed.pkt.replace(/^ospd2\./, "ospd1.");
    await expect(
      decodePortableDropPacket(legacy, sealed.bearerToken),
    ).rejects.toMatchObject({ code: "tampered" });
    await expect(
      openPortableDropBundle(legacy, sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "tampered" });
  });

  it("binds the code-encrypted manifest to its claim and expiry", async () => {
    const { sealed } = await bundle();
    const decoded = await decodePortableDropPacket(
      sealed.pkt,
      sealed.bearerToken,
    );
    await expect(
      openPortableDropManifest({ ...decoded, claimId: "another-claim" }, CODE),
    ).resolves.toBeNull();
    await expect(
      openPortableDropManifest(
        { ...decoded, expiresAtMs: decoded.expiresAtMs + 1 },
        CODE,
      ),
    ).resolves.toBeNull();
  });

  it("refuses an altered packet as tampered", async () => {
    const { sealed } = await bundle();
    const parts = sealed.pkt.split(".");
    const ciphertext = parts.at(-1);
    if (!ciphertext) throw new Error("expected packet ciphertext");
    parts[parts.length - 1] = flipFirst(ciphertext);
    await expect(
      openPortableDropBundle(parts.join("."), sealed.bearerToken, CODE),
    ).rejects.toMatchObject({ code: "tampered" });
  });
});
