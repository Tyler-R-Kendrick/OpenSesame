import { describe, expect, it } from "vitest";
import { loadAge } from "../../age-lib.js";
import { isBech32 } from "./bech32.js";

describe("bech32 as age writes it", () => {
  it("accepts the recipient and the identity the library itself mints, and no other string", async () => {
    const age = await loadAge();
    for (let n = 0; n < 8; n++) {
      const identity = await age.generateX25519Identity();
      const recipient = await age.identityToRecipient(identity);
      expect(isBech32(recipient, "age", 52)).toBe(true);
      expect(isBech32(identity, "AGE-SECRET-KEY-", 52)).toBe(true);
      // One character changed anywhere breaks the checksum.
      const at = 10 + n;
      const flipped = `${recipient.slice(0, at)}${recipient[at] === "q" ? "p" : "q"}${recipient.slice(at + 1)}`;
      expect(isBech32(flipped, "age", 52)).toBe(false);
      expect(isBech32(identity.toLowerCase(), "AGE-SECRET-KEY-", 52)).toBe(
        true,
      );
    }
  });

  it("refuses a wrong prefix, a wrong length, a stray character and mixed case", () => {
    expect(isBech32("age1", "age", 52)).toBe(false);
    expect(
      isBech32(
        "bge1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        "age",
        52,
      ),
    ).toBe(false);
    expect(isBech32("age1bio", "age", 0)).toBe(false);
    expect(
      isBech32(
        "Age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        "age",
        52,
      ),
    ).toBe(false);
  });

  it("checks the BIP-173 vectors", () => {
    expect(isBech32("a12uel5l", "a", 0)).toBe(true);
    expect(isBech32("A12UEL5L", "a", 0)).toBe(true);
    expect(isBech32("a12uel5m", "a", 0)).toBe(false);
    expect(
      isBech32("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw", "abcdef", 32),
    ).toBe(true);
  });
});
