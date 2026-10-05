import { DEFAULT_RULES, type RulesGenerator } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import policy from "../../../../../../spec/conformance/password-policy.json" with {
  type: "json",
};
import { buildCharacters, effectiveLength } from "./characters.js";
import { generatePassphraseFor } from "./passphrase.js";
import { generateRules } from "./rules.js";

const rules = (over: Partial<RulesGenerator> = {}): RulesGenerator => ({
  id: "rules",
  ...DEFAULT_RULES,
  ...over,
});

const count = (value: string, pool: string) =>
  [...value].filter((c) => pool.includes(c)).length;

describe("generateRules", () => {
  it("honours length and one of each selected class", () => {
    for (let i = 0; i < 100; i += 1) {
      const out = generateRules(rules({ length: 16 }));
      expect(out).toHaveLength(16);
      for (const pool of Object.values(policy.classes)) {
        expect(count(out, pool)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("honours minDigits and minSymbols", () => {
    for (let i = 0; i < 100; i += 1) {
      const out = generateRules(
        rules({ length: 12, minDigits: 4, minSymbols: 3 }),
      );
      expect(out).toHaveLength(12);
      expect(count(out, policy.classes.digits)).toBeGreaterThanOrEqual(4);
      expect(count(out, policy.classes.symbols)).toBeGreaterThanOrEqual(3);
    }
  });

  it("grows past the length rather than break a floor", () => {
    const out = generateRules(
      rules({ length: 4, minDigits: 5, minSymbols: 5 }),
    );
    expect(out).toHaveLength(12);
    expect(
      effectiveLength(rules({ length: 4, minDigits: 5, minSymbols: 5 })),
    ).toBe(12);
  });

  it("ignores a floor for a class that is not selected", () => {
    const out = generateRules(rules({ digits: false, minDigits: 9 }));
    expect(count(out, policy.classes.digits)).toBe(0);
    expect(out).toHaveLength(DEFAULT_RULES.length);
  });

  it("keeps the ambiguous set out when asked, and lets it in otherwise", () => {
    let seen = false;
    for (let i = 0; i < 200; i += 1) {
      expect(
        count(generateRules(rules({ avoidAmbiguous: true })), policy.ambiguous),
      ).toBe(0);
      if (count(generateRules(rules({ length: 64 })), policy.ambiguous) > 0) {
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });

  it("refuses rules that select no class", () => {
    expect(() =>
      generateRules(
        rules({ lower: false, upper: false, digits: false, symbols: false }),
      ),
    ).toThrow(/at least one character set/);
  });

  it("makes different passwords", () => {
    const all = new Set(
      Array.from({ length: 50 }, () => generateRules(rules())),
    );
    expect(all.size).toBe(50);
  });

  it("draws every character of a single class about equally often", () => {
    const only = rules({
      length: 64,
      lower: false,
      upper: false,
      symbols: false,
      avoidAmbiguous: false,
    });
    const counts = new Map<string, number>();
    const runs = 400;
    for (let i = 0; i < runs; i += 1) {
      for (const c of generateRules(only))
        counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const expected = (runs * 64) / 10;
    let chi = 0;
    for (const n of counts.values()) chi += (n - expected) ** 2 / expected;
    expect(counts.size).toBe(10);
    expect(chi).toBeLessThan(9 + 6 * Math.sqrt(18));
  });
});

describe("buildCharacters", () => {
  it("is a pure function of its source", () => {
    const stream = (seed: number) => {
      let n = seed;
      return {
        index(max: number) {
          n = (n * 1103515245 + 12345) % 2 ** 31;
          return n % max;
        },
      };
    };
    const a = buildCharacters({ ...DEFAULT_RULES }, stream(7));
    expect(buildCharacters({ ...DEFAULT_RULES }, stream(7))).toBe(a);
    expect(buildCharacters({ ...DEFAULT_RULES }, stream(8))).not.toBe(a);
  });
});

describe("generatePassphraseFor", () => {
  it("wraps the passphrase generator with the generator's options", () => {
    const out = generatePassphraseFor({
      id: "passphrase",
      words: 5,
      separator: ".",
      capitalize: false,
      includeNumber: false,
    });
    expect(out.split(".")).toHaveLength(5);
    expect(out).toBe(out.toLowerCase());
    expect(out).not.toMatch(/\d/);
  });
});
