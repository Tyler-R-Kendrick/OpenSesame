import { describe, expect, it } from "vitest";
import {
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  VaultCorruptError,
  assertKdfParams,
  assertSealed,
  b64ToBytes,
  bytesToB64,
  createVault,
  importVaultKey,
  openJson,
  rewrapVaultKey,
  sealJson,
  unlockVaultKey,
  unwrapRawVaultKeyFromPassword,
  wrapVaultKeyWithPassword,
} from "./crypto.js";

const PASSWORD = "correct horse battery staple";

describe("base64 helpers", () => {
  it("round-trip arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(Array.from(b64ToBytes(bytesToB64(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});

describe("assertKdfParams", () => {
  async function kdf() {
    const { header } = await createVault(PASSWORD);
    if (!header.kdf) throw new Error("expected kdf params");
    return header.kdf;
  }

  it("accepts what createVault produces", async () => {
    const params = await kdf();
    expect(() => assertKdfParams(params)).not.toThrow();
  });

  it("rejects a foreign algorithm", async () => {
    const base = await kdf();
    expect(() => assertKdfParams({ ...base, alg: "argon2" as never })).toThrow(
      /unsupported key derivation/,
    );
  });

  it("rejects iteration counts outside the envelope", async () => {
    const base = await kdf();
    expect(() =>
      assertKdfParams({ ...base, iterations: PBKDF2_ITERATIONS - 1 }),
    ).toThrow(/parameters were altered/);
    expect(() =>
      assertKdfParams({ ...base, iterations: MAX_PBKDF2_ITERATIONS + 1 }),
    ).toThrow(/parameters were altered/);
    expect(() => assertKdfParams({ ...base, iterations: 600_000.5 })).toThrow(
      /parameters were altered/,
    );
  });

  it("rejects a salt of the wrong size", async () => {
    const base = await kdf();
    expect(() =>
      assertKdfParams({ ...base, saltB64: bytesToB64(new Uint8Array(8)) }),
    ).toThrow(/salt is the wrong size/);
  });
});

describe("createVault", () => {
  it("records the hint only when one is given", async () => {
    const withHint = await createVault(PASSWORD, "the usual");
    expect(withHint.header.hint).toBe("the usual");
    const without = await createVault(PASSWORD);
    expect(without.header.hint).toBeUndefined();
  });
});

describe("unwrapRawVaultKeyFromPassword", () => {
  it("rejects unknown vault format versions", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(
      unwrapRawVaultKeyFromPassword({ ...header, v: 2 as never }, PASSWORD),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("rejects a header with no password wrap", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(
      unwrapRawVaultKeyFromPassword({ ...header, wrap: undefined }, PASSWORD),
    ).rejects.toThrow(/no master-password unlock/);
  });
});

describe("unlockVaultKey", () => {
  it("derives a working key straight from the header", async () => {
    const { header, vaultKey } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { ok: true });
    const unlocked = await unlockVaultKey(header, PASSWORD);
    await expect(openJson(unlocked, sealed)).resolves.toEqual({ ok: true });
  });
});

describe("wrapVaultKeyWithPassword", () => {
  it("wraps a raw key so the password can recover it", async () => {
    const { rawVaultKey } = await createVault(PASSWORD);
    const { kdf, wrap } = await wrapVaultKeyWithPassword(
      rawVaultKey,
      "another strong passphrase",
    );
    const raw = await unwrapRawVaultKeyFromPassword(
      { v: 1, kdf, wrap, createdAt: new Date().toISOString() },
      "another strong passphrase",
    );
    expect(Array.from(raw)).toEqual(Array.from(rawVaultKey));
    raw.fill(0);
    rawVaultKey.fill(0);
  });
});

describe("rewrapVaultKey edge cases", () => {
  it("refuses a header with no password wrap", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(
      rewrapVaultKey(
        { ...header, wrap: undefined, kdf: undefined },
        PASSWORD,
        "new passphrase value",
      ),
    ).rejects.toThrow(/no master-password unlock/);
  });

  it("clears the hint when handed an empty string", async () => {
    const { header } = await createVault(PASSWORD, "the usual");
    const next = await rewrapVaultKey(
      header,
      PASSWORD,
      "a much better passphrase",
      "",
    );
    expect(next.hint).toBeUndefined();
  });
});

describe("openJson", () => {
  it("calls a tag mismatch corruption, not a wrong password", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const other = await createVault("another strong passphrase");
    const sealed = await sealJson(other.vaultKey, { ok: true });
    await expect(openJson(vaultKey, sealed)).rejects.toThrow(
      /authentication tag mismatch/,
    );
  });

  it("calls decrypted non-JSON corruption", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      vaultKey,
      new TextEncoder().encode("this is not json"),
    );
    await expect(
      openJson(vaultKey, {
        ivB64: bytesToB64(iv),
        ctB64: bytesToB64(new Uint8Array(ct)),
      }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("assertSealed", () => {
  it("refuses blobs missing either half", () => {
    expect(() => assertSealed({ ivB64: "", ctB64: "x" })).toThrow(/unsealed/);
    expect(() => assertSealed({ ivB64: "x", ctB64: "" })).toThrow(/unsealed/);
    expect(() => assertSealed({ ivB64: "x", ctB64: "y" })).not.toThrow();
  });
});

describe("importVaultKey", () => {
  it("imports raw bytes as a non-extractable AES-GCM key", async () => {
    const key = await importVaultKey(new Uint8Array(32).fill(7));
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });
});
