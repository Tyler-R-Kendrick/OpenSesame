import { VaultCorruptError, WrongPepperError } from "@opensesame/vault-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openWithOpaque,
  sealWithOpaque,
  writeSealsWith,
} from "./opaque-seal.js";

const BINDING = "pepper-seal\u0000acct-1\u0000acct-1:password";
const PEPPER = "pepper-4e81-never-in-the-seal";
const SECRET = "the-secret-8c19";

// This file runs the real Argon2id cost (64 MiB, three passes); the rest of the
// suites ask for the cheap one in their setup.
beforeAll(() => writeSealsWith("standard"));
afterAll(() => writeSealsWith("fast"));

describe("the OPAQUE pepper seal at its standard cost", () => {
  it("writes a v2 seal that holds neither the secret nor the pepper, and opens with the pepper", async () => {
    const started = performance.now();
    const seal = await sealWithOpaque(SECRET, PEPPER, BINDING);
    expect(seal).toMatchObject({
      v: 2,
      suite: "rfc9807-ristretto255-argon2id",
      ksf: "standard",
    });
    const text = JSON.stringify(seal);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PEPPER);
    expect(await openWithOpaque(seal, PEPPER, BINDING)).toBe(SECRET);
    // Real memory-hard work, well under what a person waits for at a prompt.
    expect(performance.now() - started).toBeLessThan(8_000);
  });

  it("fails a wrong or empty pepper before anything is decrypted, never returning a wrong secret", async () => {
    const seal = await sealWithOpaque(SECRET, PEPPER, BINDING);
    for (const wrong of ["not-the-pepper-123", "", `${PEPPER} `]) {
      await expect(openWithOpaque(seal, wrong, BINDING)).rejects.toBeInstanceOf(
        WrongPepperError,
      );
    }
  });

  it("treats a pepper the way the unlock screen does: NFKC-normalised", async () => {
    const seal = await sealWithOpaque(SECRET, "ﬁnal-pepper-ﬁ", BINDING);
    expect(await openWithOpaque(seal, "final-pepper-fi", BINDING)).toBe(SECRET);
  });

  it("will not open for another account or method, or after any part is changed", async () => {
    const seal = await sealWithOpaque(SECRET, PEPPER, BINDING);
    const moved = "pepper-seal\u0000acct-2\u0000acct-2:password";
    await expect(openWithOpaque(seal, PEPPER, moved)).rejects.toBeInstanceOf(
      WrongPepperError,
    );
    const flip = (text: string) =>
      `${text.slice(0, 20)}${text[20] === "A" ? "B" : "A"}${text.slice(21)}`;
    // A changed ciphertext opens the OPAQUE record and fails the seal; a changed
    // record either cannot be read or fails the login. None returns a secret.
    await expect(
      openWithOpaque(
        { ...seal, seal: { ...seal.seal, ctB64: flip(seal.seal.ctB64) } },
        PEPPER,
        BINDING,
      ),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      openWithOpaque(
        { ...seal, registrationRecord: flip(seal.registrationRecord) },
        PEPPER,
        BINDING,
      ),
    ).rejects.toSatisfy(
      (error: Error) =>
        error instanceof VaultCorruptError || error instanceof WrongPepperError,
    );
  });

  it("applies its key stretching: a seal written at the cheap cost does not open as the standard one", async () => {
    writeSealsWith("fast");
    const cheap = await sealWithOpaque(SECRET, PEPPER, BINDING);
    writeSealsWith("standard");
    expect(cheap.ksf).toBe("fast");
    expect(await openWithOpaque(cheap, PEPPER, BINDING)).toBe(SECRET);
    await expect(
      openWithOpaque({ ...cheap, ksf: "standard" }, PEPPER, BINDING),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });

  it("gives every seal its own server setup and ciphertext, so two seals of one secret differ", async () => {
    const a = await sealWithOpaque(SECRET, PEPPER, BINDING);
    const b = await sealWithOpaque(SECRET, PEPPER, BINDING);
    expect(a.serverSetup).not.toBe(b.serverSetup);
    expect(a.seal.ctB64).not.toBe(b.seal.ctB64);
  });

  it("refuses an empty pepper to seal", async () => {
    await expect(sealWithOpaque(SECRET, "", BINDING)).rejects.toThrow(/pepper/);
  });
});
