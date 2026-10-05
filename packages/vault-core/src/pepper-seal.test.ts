import { describe, expect, it } from "vitest";
import { VaultCorruptError } from "./crypto.js";
import {
  WrongPepperError,
  openWithPepper,
  pepperBinding,
  sealWithPepper,
} from "./pepper-seal.js";

const binding = pepperBinding("acct-1", "method-1");

describe("pepper seal", () => {
  it("opens with the pepper it was sealed under", async () => {
    const sealed = await sealWithPepper("p@ss w0rd", "my pepper", binding);
    expect(await openWithPepper(sealed, "my pepper", binding)).toBe(
      "p@ss w0rd",
    );
  });

  it("holds no plaintext and a fresh salt and nonce each time", async () => {
    const a = await sealWithPepper("same", "pepper", binding);
    const b = await sealWithPepper("same", "pepper", binding);
    expect(JSON.stringify(a)).not.toContain("same");
    expect(a.kdf.saltB64).not.toBe(b.kdf.saltB64);
    expect(a.seal.ivB64).not.toBe(b.seal.ivB64);
    expect(a.seal.ctB64).not.toBe(b.seal.ctB64);
  });

  it("refuses a wrong pepper", async () => {
    const sealed = await sealWithPepper("secret", "right", binding);
    await expect(
      openWithPepper(sealed, "wrong", binding),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("treats the pepper as NFKC, like the vault's password", async () => {
    const sealed = await sealWithPepper("secret", "Ｐepper", binding);
    expect(await openWithPepper(sealed, "Pepper", binding)).toBe("secret");
  });

  it("will not open under another account or method", async () => {
    const sealed = await sealWithPepper("secret", "pepper", binding);
    await expect(
      openWithPepper(sealed, "pepper", pepperBinding("acct-1", "method-2")),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      openWithPepper(sealed, "pepper", pepperBinding("acct-2", "method-1")),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("refuses an empty pepper and weakened or unknown parameters", async () => {
    await expect(sealWithPepper("secret", "", binding)).rejects.toThrow();
    const sealed = await sealWithPepper("secret", "pepper", binding);
    await expect(
      openWithPepper(
        { ...sealed, kdf: { ...sealed.kdf, iterations: 1 } },
        "pepper",
        binding,
      ),
    ).rejects.toBeInstanceOf(VaultCorruptError);
    await expect(
      openWithPepper({ ...sealed, v: 2 as 1 }, "pepper", binding),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("round-trips an empty password", async () => {
    const sealed = await sealWithPepper("", "pepper", binding);
    expect(await openWithPepper(sealed, "pepper", binding)).toBe("");
  });
});
