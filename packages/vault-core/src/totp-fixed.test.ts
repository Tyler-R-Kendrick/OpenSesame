import { describe, expect, it } from "vitest";
import {
  type TotpConfig,
  TotpParseError,
  parseTotp,
  parseTotpFixed,
  secondsRemaining,
  totpCode,
  totpCodeFixed,
  totpSeams,
} from "./totp.js";

/** RFC 6238 Appendix B public test seeds, never production factor material. */
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const vectors: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1_111_111_109, "07081804", "68084774", "25091201"],
  [1_111_111_111, "14050471", "67062674", "99943326"],
  [1_234_567_890, "89005924", "91819424", "93441116"],
  [2_000_000_000, "69279037", "90698825", "38618901"],
  [20_000_000_000, "65353130", "77737706", "47863826"],
];

const algorithmSeeds: Array<[TotpConfig["algorithm"], string, number]> = [
  ["SHA-1", "12345678901234567890", 1],
  ["SHA-256", "12345678901234567890123456789012", 2],
  [
    "SHA-512",
    "1234567890123456789012345678901234567890123456789012345678901234",
    3,
  ],
];

function uri(params: string): string {
  return `otpauth://totp/Example:test?secret=${RFC_SEED}&${params}`;
}

describe("fixed RFC 6238 bindings", () => {
  for (const [algorithm, seed, column] of algorithmSeeds) {
    for (const row of vectors) {
      it(`${algorithm} at ${row[0]} matches the independent RFC vector`, async () => {
        const config: TotpConfig = {
          secret: new TextEncoder().encode(seed),
          digits: 8,
          period: 30,
          algorithm,
        };
        await expect(totpCodeFixed(config, row[0] * 1000)).resolves.toBe(
          row[column],
        );
      });
    }
  }

  it("preserves legacy parsing, defaults and code interoperability", async () => {
    expect(parseTotpFixed).toBe(totpSeams.parseTotp);
    expect(totpCodeFixed).toBe(totpSeams.totpCode);
    const bare = parseTotpFixed(`  ${RFC_SEED.toLowerCase()}  `);
    expect(bare).toEqual(parseTotp(RFC_SEED));
    expect(new TextDecoder().decode(bare.secret)).toBe("12345678901234567890");
    expect({
      digits: bare.digits,
      period: bare.period,
      algorithm: bare.algorithm,
    }).toEqual({ digits: 6, period: 30, algorithm: "SHA-1" });
    await expect(totpCodeFixed(bare, 59_000)).resolves.toBe("287082");
    await expect(totpCode(bare, 59_000)).resolves.toBe("287082");
    const configured = parseTotpFixed(
      uri("digits=8&period=60&algorithm=SHA256"),
    );
    expect(configured).toEqual(
      parseTotp(uri("digits=8&period=60&algorithm=SHA256")),
    );
    expect(configured.digits).toBe(8);
    expect(configured.period).toBe(60);
    expect(configured.algorithm).toBe("SHA-256");
  });

  for (const malformed of [
    "",
    "ABC1",
    uri("digits=5"),
    uri("digits=8&digits=6"),
    uri("period=0"),
    uri("algorithm=MD5"),
    uri("period=30#fragment"),
    `otpauth://hotp/test?secret=${RFC_SEED}&counter=0`,
  ]) {
    it(`refuses invalid fixed-parser input ${JSON.stringify(malformed)}`, () => {
      expect(() => parseTotpFixed(malformed)).toThrow(TotpParseError);
      expect(() => parseTotp(malformed)).toThrow(TotpParseError);
    });
  }

  it("keeps fixed parsing and genuine HMAC independent of replacement seams", async () => {
    const original = { ...totpSeams };
    const config = parseTotpFixed(uri("digits=8"));
    try {
      totpSeams.parseTotp = () => {
        throw new Error("replacement legacy parser");
      };
      totpSeams.totpCode = async () => "00000000";
      totpSeams.secondsRemaining = () => -1;
      expect(() => parseTotp(RFC_SEED)).toThrow("replacement legacy parser");
      await expect(totpCode(config, 59_000)).resolves.toBe("00000000");
      expect(secondsRemaining(30, 59_000)).toBe(-1);
      expect(parseTotpFixed(uri("digits=8"))).toEqual(config);
      expect(() => parseTotpFixed(uri("digits=5"))).toThrow(TotpParseError);
      await expect(totpCodeFixed(config, 59_000)).resolves.toBe("94287082");
      expect(parseTotpFixed).toBe(original.parseTotp);
      expect(totpCodeFixed).toBe(original.totpCode);
    } finally {
      Object.assign(totpSeams, original);
    }
    expect(parseTotp(RFC_SEED)).toEqual(parseTotpFixed(RFC_SEED));
    await expect(totpCode(config, 59_000)).resolves.toBe("94287082");
  });
});
