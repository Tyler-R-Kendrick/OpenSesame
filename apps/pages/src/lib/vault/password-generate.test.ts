import { describe, expect, it } from "vitest";
import {
  WORDS,
  defaultCharOptions,
  defaultPassphraseOptions,
  estimateStrength,
  generate,
  generateCharacters,
  generatePassphrase,
  generatorEntropyBits,
} from "./password.js";

describe("generateCharacters", () => {
  it("requires at least one character set", () => {
    expect(() =>
      generateCharacters({
        mode: "characters",
        length: 20,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
        avoidAmbiguous: true,
      }),
    ).toThrow(/at least one character set/);
  });

  it("honours the requested length and keeps ambiguous glyphs out", () => {
    for (let i = 0; i < 20; i += 1) {
      const out = generateCharacters({ ...defaultCharOptions, length: 24 });
      expect(out).toHaveLength(24);
      expect(out).toMatch(/[a-z]/);
      expect(out).toMatch(/[A-Z]/);
      expect(out).toMatch(/[0-9]/);
      expect(out).not.toMatch(/[il1Lo0O]/);
    }
  });

  it("allows ambiguous glyphs when asked", () => {
    // With only digits and ambiguity allowed, i/l/o can't appear but 1 and 0 can.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const out = generateCharacters({
        mode: "characters",
        length: 12,
        lower: false,
        upper: false,
        digits: true,
        symbols: false,
        avoidAmbiguous: false,
      });
      for (const char of out) seen.add(char);
    }
    expect(seen.has("1") || seen.has("0")).toBe(true);
  });

  it("grows a short request to cover every selected set", () => {
    const out = generateCharacters({ ...defaultCharOptions, length: 1 });
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it("works with a single set", () => {
    const out = generateCharacters({
      mode: "characters",
      length: 32,
      lower: true,
      upper: false,
      digits: false,
      symbols: false,
      avoidAmbiguous: false,
    });
    expect(out).toMatch(/^[a-z]{32}$/u);
  });
});

describe("generatePassphrase", () => {
  it("builds capitalized, numbered words joined by the separator", () => {
    const out = generatePassphrase({
      mode: "passphrase",
      words: 5,
      separator: ".",
      capitalize: true,
      includeNumber: true,
    });
    const parts = out.split(".");
    expect(parts).toHaveLength(5);
    expect(parts.some((part) => /\d$/u.test(part))).toBe(true);
    for (const part of parts) {
      expect(part.replace(/\d+$/u, "")).toMatch(/^[A-Z][a-z]+$/u);
    }
  });

  it("clamps the word count and falls back to a dash", () => {
    const few = generatePassphrase({
      mode: "passphrase",
      words: 1,
      separator: "",
      capitalize: false,
      includeNumber: false,
    });
    expect(few.split("-")).toHaveLength(3); // minimum

    const many = generatePassphrase({
      ...defaultPassphraseOptions,
      words: 99,
      capitalize: false,
      includeNumber: false,
    });
    expect(many.split("-")).toHaveLength(12); // maximum
    for (const word of many.split("-")) {
      expect(WORDS).toContain(word);
    }
  });
});

describe("generate dispatch", () => {
  it("routes by mode", () => {
    expect(generate(defaultCharOptions)).toHaveLength(
      defaultCharOptions.length,
    );
    expect(
      generate(defaultPassphraseOptions).split("-").length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("generatorEntropyBits", () => {
  it("counts the wordlist and the optional digit for passphrases", () => {
    const withNumber = generatorEntropyBits(defaultPassphraseOptions);
    const without = generatorEntropyBits({
      ...defaultPassphraseOptions,
      includeNumber: false,
    });
    // 4 words * 8 bits + log2(10) for the appended digit.
    expect(withNumber).toBe(Math.round(4 * 8 + Math.log2(10)));
    expect(without).toBe(4 * 8);
  });

  it("counts the alphabet for character passwords", () => {
    const bits = generatorEntropyBits(defaultCharOptions);
    // 24 + 24 + 8 + symbols, times 20 characters.
    expect(bits).toBeGreaterThan(100);
    expect(
      generatorEntropyBits({
        mode: "characters",
        length: 10,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
        avoidAmbiguous: true,
      }),
    ).toBe(0);
  });
});

describe("estimateStrength", () => {
  it("rates empty and common passwords as very weak", () => {
    expect(estimateStrength("").score).toBe(0);
    expect(estimateStrength("").bits).toBe(0);
    expect(estimateStrength("password").score).toBe(0);
    expect(estimateStrength("QwErTy").score).toBe(0);
  });

  it("penalises digit-only, repeated, and sequential passwords", () => {
    const digits = estimateStrength("93847561029384");
    const mixed = estimateStrength("9a3b8c4d7e5f10");
    expect(digits.bits).toBeLessThan(mixed.bits);

    const repeated = estimateStrength("abcabcabcaaaa123");
    expect(repeated.bits).toBeLessThan(
      estimateStrength("abcabcabcaxxa123").bits - 5,
    );

    const sequential = estimateStrength("abcdefghijklmnop");
    expect(sequential.bits).toBeLessThan(
      estimateStrength("qwfpgjluydhtnsae").bits,
    );
  });

  it("rates a real passphrase as strong", () => {
    const strength = estimateStrength("correct horse battery staple");
    expect(strength.score).toBeGreaterThanOrEqual(2);
    expect(strength.label).toMatch(/Fair|Strong|Excellent/);
  });

  it("labels every score band", () => {
    expect(estimateStrength("x").label).toBe("Very weak");
    expect(estimateStrength("tr0ub4dor").label).toBe("Weak");
    expect(estimateStrength("correct horse battery staple").label).not.toBe(
      "Weak",
    );
    expect(
      estimateStrength(
        "V3ry$Lng&UncommonPassphraseWith69Chars!AlmostNobodyGuessesThisOneRight",
      ).label,
    ).toBe("Excellent");
  });
});
