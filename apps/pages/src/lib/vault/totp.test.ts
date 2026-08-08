import { describe, expect, it } from "vitest";
import {
  TotpParseError,
  decodeBase32,
  parseTotp,
  secondsRemaining,
  totpCode,
} from "./totp.js";

/** RFC 6238 Appendix B seed: the ASCII string "12345678901234567890". */
const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function uri(digits: number, algorithm = "SHA1"): string {
  return `otpauth://totp/Example:alice@example.com?secret=${RFC_SEED_BASE32}&issuer=Example&digits=${digits}&algorithm=${algorithm}&period=30`;
}

describe("base32", () => {
  it("decodes the RFC seed to its ASCII bytes", () => {
    expect(new TextDecoder().decode(decodeBase32(RFC_SEED_BASE32))).toBe(
      "12345678901234567890",
    );
  });

  it("tolerates padding, spaces, and lowercase", () => {
    expect(decodeBase32("jbsw y3dp ehpk 3pxp")).toEqual(
      decodeBase32("JBSWY3DPEHPK3PXP"),
    );
  });

  it("names the offending character", () => {
    expect(() => decodeBase32("ABC1")).toThrow(TotpParseError);
    expect(() => decodeBase32("ABC1")).toThrow(/"1"/);
  });

  it("rejects an empty secret", () => {
    expect(() => decodeBase32("   ")).toThrow(TotpParseError);
  });
});

describe("RFC 6238 test vectors (SHA-1, 8 digits)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ];

  for (const [seconds, expected] of vectors) {
    it(`T=${seconds} produces ${expected}`, async () => {
      const config = parseTotp(uri(8));
      await expect(totpCode(config, seconds * 1000)).resolves.toBe(expected);
    });
  }
});

describe("parsing", () => {
  it("treats a bare string as a 6-digit SHA-1 seed on a 30 second period", () => {
    const config = parseTotp(RFC_SEED_BASE32);
    expect(config.digits).toBe(6);
    expect(config.period).toBe(30);
    expect(config.algorithm).toBe("SHA-1");
  });

  it("honours digits, period, and algorithm from an otpauth URI", () => {
    const config = parseTotp(uri(8, "SHA256"));
    expect(config.digits).toBe(8);
    expect(config.algorithm).toBe("SHA-256");
  });

  it("rejects an otpauth URI with no secret", () => {
    expect(() => parseTotp("otpauth://totp/Example?issuer=Example")).toThrow(
      TotpParseError,
    );
  });

  it("truncates to the requested digit count", async () => {
    const six = await totpCode(parseTotp(uri(6)), 59_000);
    expect(six).toBe("287082");
    expect(six).toHaveLength(6);
  });
});

describe("period countdown", () => {
  it("reports the seconds left in the current window", () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 29_000)).toBe(1);
    expect(secondsRemaining(30, 30_000)).toBe(30);
  });
});
