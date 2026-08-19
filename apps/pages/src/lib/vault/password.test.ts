import { describe, expect, it } from "vitest";
import {
  WORDS,
  defaultCharOptions,
  defaultPassphraseOptions,
  estimateStrength,
  generateCharacters,
  generatePassphrase,
  generatorEntropyBits,
} from "./password.js";

describe("character generator", () => {
  it("honours the requested length", () => {
    for (const length of [8, 16, 20, 64]) {
      expect(
        generateCharacters({ ...defaultCharOptions, length }),
      ).toHaveLength(length);
    }
  });

  it("includes at least one character from every selected set", () => {
    for (let i = 0; i < 50; i += 1) {
      const value = generateCharacters({ ...defaultCharOptions, length: 12 });
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[0-9]/);
      expect(value).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("omits sets the user turned off", () => {
    const value = generateCharacters({
      ...defaultCharOptions,
      symbols: false,
      digits: false,
      length: 30,
    });
    expect(value).toMatch(/^[A-Za-z]+$/);
  });

  it("avoids ambiguous glyphs when asked", () => {
    for (let i = 0; i < 50; i += 1) {
      const value = generateCharacters({
        ...defaultCharOptions,
        length: 40,
        avoidAmbiguous: true,
      });
      expect(value).not.toMatch(/[il1LoO0]/);
    }
  });

  it("refuses to generate from an empty alphabet", () => {
    expect(() =>
      generateCharacters({
        ...defaultCharOptions,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
      }),
    ).toThrow(/at least one character set/i);
  });

  it("never repeats a value across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(generateCharacters(defaultCharOptions));
    }
    expect(seen.size).toBe(500);
  });

  it("lengthens rather than dropping a required set", () => {
    const value = generateCharacters({ ...defaultCharOptions, length: 2 });
    expect(value.length).toBeGreaterThanOrEqual(4);
  });
});

describe("passphrase generator", () => {
  it("produces the requested number of words", () => {
    const value = generatePassphrase({ ...defaultPassphraseOptions, words: 5 });
    expect(value.split("-")).toHaveLength(5);
  });

  it("clamps absurd word counts", () => {
    expect(
      generatePassphrase({ ...defaultPassphraseOptions, words: 99 }).split("-"),
    ).toHaveLength(12);
    expect(
      generatePassphrase({ ...defaultPassphraseOptions, words: 1 }).split("-"),
    ).toHaveLength(3);
  });

  it("uses only words from the bundled list", () => {
    const value = generatePassphrase({
      ...defaultPassphraseOptions,
      capitalize: false,
      includeNumber: false,
    });
    for (const word of value.split("-")) {
      expect(WORDS).toContain(word);
    }
  });

  it("respects the separator", () => {
    const value = generatePassphrase({
      ...defaultPassphraseOptions,
      separator: ".",
    });
    expect(value.split(".")).toHaveLength(defaultPassphraseOptions.words);
  });
});

describe("entropy accounting", () => {
  it("reports the generator's own configuration exactly", () => {
    const bits = generatorEntropyBits({
      mode: "characters",
      length: 20,
      lower: true,
      upper: false,
      digits: false,
      symbols: false,
      avoidAmbiguous: false,
    });
    expect(bits).toBe(Math.round(20 * Math.log2(26)));
  });

  it("scales with word count for passphrases", () => {
    const four = generatorEntropyBits({
      ...defaultPassphraseOptions,
      words: 4,
    });
    const eight = generatorEntropyBits({
      ...defaultPassphraseOptions,
      words: 8,
    });
    expect(eight).toBeGreaterThan(four * 1.8);
  });
});

describe("strength estimation", () => {
  it("scores an empty password at the floor", () => {
    expect(estimateStrength("").score).toBe(0);
  });

  it("punishes the obvious ones", () => {
    for (const password of ["password", "123456", "qwerty", "letmein"]) {
      expect(estimateStrength(password).score).toBe(0);
    }
  });

  it("punishes repetition", () => {
    expect(estimateStrength("aaaaaaaaaaaaaaaaaaaa").score).toBeLessThanOrEqual(
      1,
    );
  });

  it("punishes keyboard runs", () => {
    const run = estimateStrength("abcdefgh").bits;
    const noRun = estimateStrength("qm3zvxpt").bits;
    expect(run).toBeLessThan(noRun);
  });

  it("treats long digit strings as weaker than mixed input of equal length", () => {
    expect(estimateStrength("839201748265").bits).toBeLessThan(
      estimateStrength("aR7#kQ2!mZ9x").bits,
    );
  });

  it("rates generated output highly", () => {
    const value = generateCharacters({ ...defaultCharOptions, length: 24 });
    expect(estimateStrength(value).score).toBe(4);
  });

  it("rates a four-word passphrase as at least strong", () => {
    const value = generatePassphrase(defaultPassphraseOptions);
    expect(estimateStrength(value).score).toBeGreaterThanOrEqual(3);
  });
});
