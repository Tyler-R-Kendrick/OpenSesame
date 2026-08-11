import { describe, expect, it } from "vitest";
import {
  VaultCorruptError,
  WrongPasswordError,
  b64ToBytes,
  bytesToB64,
  createVault,
  openJson,
  randomBytes,
  rewrapVaultKey,
  sealJson,
  unlockVaultKey,
} from "./crypto.js";

// A low iteration count keeps the suite fast; the production floor is asserted separately.
const PASSWORD = "correct horse battery staple";

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = randomBytes(64);
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });
});

describe("vault key lifecycle", () => {
  it("unlocks with the right password and seals a payload", async () => {
    const { header, vaultKey } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { hello: "world" });

    const reopened = await unlockVaultKey(header, PASSWORD);
    await expect(openJson(reopened, sealed)).resolves.toEqual({
      hello: "world",
    });
  });

  it("rejects the wrong password without leaking the key", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(unlockVaultKey(header, `${PASSWORD}!`)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("uses at least the OWASP PBKDF2 floor", async () => {
    const { header } = await createVault(PASSWORD);
    expect(header.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(header.kdf.alg).toBe("PBKDF2-SHA256");
  });

  it("mints a distinct salt and wrapped key per vault", async () => {
    const a = await createVault(PASSWORD);
    const b = await createVault(PASSWORD);
    expect(a.header.kdf.saltB64).not.toBe(b.header.kdf.saltB64);
    expect(a.header.wrap.ctB64).not.toBe(b.header.wrap.ctB64);
  });

  it("never stores the password or plaintext in the header", async () => {
    const { header } = await createVault(PASSWORD, "four words, no numbers");
    const serialised = JSON.stringify(header);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain("staple");
  });

  it("produces ciphertext that does not contain the plaintext", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { secret: "hunter2-unmistakable" });
    expect(sealed.ctB64).not.toContain("hunter2");
    expect(atob(sealed.ctB64)).not.toContain("hunter2");
  });

  it("uses a fresh nonce for every seal", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const first = await sealJson(vaultKey, { n: 1 });
    const second = await sealJson(vaultKey, { n: 1 });
    expect(first.ivB64).not.toBe(second.ivB64);
    expect(first.ctB64).not.toBe(second.ctB64);
  });

  it("detects tampering through the GCM tag", async () => {
    const { vaultKey } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { balance: 10 });
    const bytes = b64ToBytes(sealed.ctB64);
    bytes[0] ^= 0xff;

    await expect(
      openJson(vaultKey, { ivB64: sealed.ivB64, ctB64: bytesToB64(bytes) }),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("rejects a header from an unsupported format", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(
      unlockVaultKey({ ...header, v: 2 as unknown as 1 }, PASSWORD),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });
});

describe("changing the master password", () => {
  it("keeps the same vault key so items need no re-encryption", async () => {
    const { header, vaultKey } = await createVault(PASSWORD);
    const sealed = await sealJson(vaultKey, { kept: true });

    const next = await rewrapVaultKey(
      header,
      PASSWORD,
      "a whole new passphrase here",
    );

    const reopened = await unlockVaultKey(next, "a whole new passphrase here");
    await expect(openJson(reopened, sealed)).resolves.toEqual({ kept: true });
  });

  it("retires the old password", async () => {
    const { header } = await createVault(PASSWORD);
    const next = await rewrapVaultKey(
      header,
      PASSWORD,
      "a whole new passphrase here",
    );
    await expect(unlockVaultKey(next, PASSWORD)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("refuses to re-wrap without the current password", async () => {
    const { header } = await createVault(PASSWORD);
    await expect(
      rewrapVaultKey(header, "not it", "a whole new passphrase here"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("rotates the salt so the two derivations are unrelated", async () => {
    const { header } = await createVault(PASSWORD);
    const next = await rewrapVaultKey(
      header,
      PASSWORD,
      "a whole new passphrase here",
    );
    expect(next.kdf.saltB64).not.toBe(header.kdf.saltB64);
  });
});
