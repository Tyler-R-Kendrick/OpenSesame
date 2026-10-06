import { describe, expect, it } from "vitest";
import { type CharacterRules, DEFAULT_RULES } from "./account.js";
import { b64ToBytes } from "./bytes.js";
import { ruleAlphabet } from "./character-rules.js";
import {
  MAX_COUNTER,
  ROOT_SECRET_BYTES,
  deriveCharacters,
  mintRootSecret,
} from "./derive.js";

const ROOT = mintRootSecret();
const RULES: CharacterRules = { ...DEFAULT_RULES };

describe("a minted root", () => {
  it("is 32 random bytes and never repeats", () => {
    const seen = new Set(Array.from({ length: 50 }, mintRootSecret));
    expect(seen.size).toBe(50);
    expect(b64ToBytes([...seen][0] ?? "")).toHaveLength(ROOT_SECRET_BYTES);
  });
});

describe("deriveCharacters", () => {
  it("is a pure function of the root and the counter", () => {
    expect(deriveCharacters(ROOT, 0, RULES)).toBe(
      deriveCharacters(ROOT, 0, RULES),
    );
    expect(deriveCharacters(ROOT, 1, RULES)).not.toBe(
      deriveCharacters(ROOT, 0, RULES),
    );
    expect(deriveCharacters(mintRootSecret(), 0, RULES)).not.toBe(
      deriveCharacters(ROOT, 0, RULES),
    );
  });

  it("has the length and classes the rules ask for", () => {
    const rules: CharacterRules = {
      ...RULES,
      length: 32,
      minDigits: 4,
      minSymbols: 3,
    };
    const password = deriveCharacters(ROOT, 7, rules);
    expect(password).toHaveLength(32);
    const alphabet = ruleAlphabet(rules);
    expect([...password].every((char) => alphabet.includes(char))).toBe(true);
    expect(
      [...password].filter((c) => /[0-9]/.test(c)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      [...password].filter((c) => /[^A-Za-z0-9]/.test(c)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(password).not.toMatch(/[il1Lo0O]/);
  });

  it("draws every character of the alphabet, evenly enough that no bias shows", () => {
    const rules: CharacterRules = {
      ...RULES,
      length: 256,
      symbols: false,
    };
    const counts = new Map<string, number>();
    for (let counter = 0; counter < 40; counter++) {
      for (const char of deriveCharacters(ROOT, counter, rules)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    const alphabet = ruleAlphabet(rules);
    expect(counts.size).toBe(alphabet.length);
    const mean = (40 * 256) / alphabet.length;
    for (const hits of counts.values()) {
      expect(hits).toBeGreaterThan(mean * 0.6);
      expect(hits).toBeLessThan(mean * 1.4);
    }
  });

  it("refuses a counter out of range, a root of the wrong size and rules that choose nothing", () => {
    expect(() => deriveCharacters(ROOT, -1, RULES)).toThrow("counter");
    expect(() => deriveCharacters(ROOT, MAX_COUNTER + 1, RULES)).toThrow(
      "counter",
    );
    expect(() => deriveCharacters(ROOT, 1.5, RULES)).toThrow("counter");
    expect(() => deriveCharacters("AAAA", 0, RULES)).toThrow("32 bytes");
    expect(() =>
      deriveCharacters(ROOT, 0, {
        ...RULES,
        lower: false,
        upper: false,
        digits: false,
        symbols: false,
      }),
    ).toThrow("character set");
    expect(deriveCharacters(ROOT, MAX_COUNTER, RULES)).toHaveLength(20);
  });
});
