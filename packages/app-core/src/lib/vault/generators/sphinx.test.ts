import { type CharacterRules, DEFAULT_RULES } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import policy from "../../../../../../spec/conformance/password-policy.json" with {
  type: "json",
};
import {
  type SphinxInput,
  mintOprfKey,
  rotateSphinx,
  sphinxInputBytes,
  sphinxPassword,
  vaultEvaluator,
} from "./sphinx.js";

const KEY = mintOprfKey();
const BASE: SphinxInput = {
  master: "correct horse battery staple",
  realm: "example.com",
  username: "ada@example.com",
  counter: 0,
  rules: { ...DEFAULT_RULES },
};

/** The message a failing call threw, or a marker when it did not throw. */
async function failure(run: () => Promise<string>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "did not throw";
}

const compute = (input: SphinxInput, key = KEY) =>
  sphinxPassword(input, vaultEvaluator(key));

describe("sphinxPassword", () => {
  it("is deterministic for a fixed master, realm, username, counter and key", async () => {
    const [a, b] = await Promise.all([compute(BASE), compute(BASE)]);
    expect(a).toBe(b);
    expect(a).toHaveLength(DEFAULT_RULES.length);
  });

  it("changes with each of master, realm, username, counter and key", async () => {
    const seen = new Set([await compute(BASE)]);
    const variants: [SphinxInput, string?][] = [
      [{ ...BASE, master: `${BASE.master}!` }],
      [{ ...BASE, realm: "example.org" }],
      [{ ...BASE, username: "grace@example.com" }],
      [{ ...BASE, counter: 1 }],
      [BASE, mintOprfKey()],
    ];
    for (const [input, key] of variants) seen.add(await compute(input, key));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("treats the master input as NFKC text", async () => {
    const composed = await compute({ ...BASE, master: "café" });
    const decomposed = await compute({ ...BASE, master: "café" });
    expect(decomposed).toBe(composed);
  });

  it("does not let adjacent fields run into one another", () => {
    const a = sphinxInputBytes({ ...BASE, realm: "ab", username: "c" });
    const b = sphinxInputBytes({ ...BASE, realm: "a", username: "bc" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("is a different password for a different shape, from the same key and input", async () => {
    const short = await compute({
      ...BASE,
      rules: { ...DEFAULT_RULES, length: 12 },
    });
    expect(short).toHaveLength(12);
  });

  it("refuses an empty master input and a counter out of range", async () => {
    await expect(compute({ ...BASE, master: "" })).rejects.toThrow(/master/);
    await expect(compute({ ...BASE, counter: -1 })).rejects.toThrow(/counter/);
    await expect(compute({ ...BASE, counter: 1.5 })).rejects.toThrow(/counter/);
    await expect(compute({ ...BASE, counter: 2 ** 32 })).rejects.toThrow(
      /counter/,
    );
  });

  it("refuses rules that select no class", async () => {
    const rules = {
      ...DEFAULT_RULES,
      lower: false,
      upper: false,
      digits: false,
      symbols: false,
    };
    await expect(compute({ ...BASE, rules })).rejects.toThrow(/character set/);
  });

  it("reports an evaluator that fails without echoing what it said", async () => {
    const evaluator = {
      evaluate: async () => {
        throw new Error(`leak ${BASE.master}`);
      },
    };
    const message = await failure(() => sphinxPassword(BASE, evaluator));
    expect(message).toMatch(/could not be computed/);
    expect(message).not.toContain(BASE.master);
  });

  it("rotates with the counter and nothing else", async () => {
    const before = {
      id: "sphinx" as const,
      rules: { ...DEFAULT_RULES },
      realm: "example.com",
      counter: 3,
      oprfKeyB64: KEY,
    };
    const after = rotateSphinx(before);
    expect(after).toEqual({ ...before, counter: 4 });
    expect(before.counter).toBe(3);
  });
});

describe("sphinxPassword obeys its rules", () => {
  const AMBIGUOUS = policy.ambiguous;
  const CLASSES = policy.classes;
  type Case = { name: string; rules: CharacterRules };
  const cases: Case[] = [
    { name: "the defaults", rules: { ...DEFAULT_RULES } },
    {
      name: "avoiding ambiguous",
      rules: { ...DEFAULT_RULES, avoidAmbiguous: true },
    },
    {
      name: "digit and symbol floors",
      rules: { ...DEFAULT_RULES, length: 24, minDigits: 5, minSymbols: 4 },
    },
    {
      name: "a PIN",
      rules: {
        ...DEFAULT_RULES,
        length: 6,
        lower: false,
        upper: false,
        symbols: false,
      },
    },
    {
      name: "floors that outgrow the length",
      rules: { ...DEFAULT_RULES, length: 8, minDigits: 6, minSymbols: 6 },
    },
  ];

  for (const { name, rules } of cases) {
    it(`for ${name}`, async () => {
      const floors = {
        lower: 1,
        upper: 1,
        digits: Math.max(1, rules.minDigits),
        symbols: Math.max(1, rules.minSymbols),
      };
      for (let counter = 0; counter < 12; counter += 1) {
        const out = await compute({ ...BASE, counter, rules });
        const chars = [...out];
        let required = 0;
        for (const id of ["lower", "upper", "digits", "symbols"] as const) {
          if (!rules[id]) {
            expect(chars.some((c) => CLASSES[id].includes(c))).toBe(false);
            continue;
          }
          required += floors[id];
          const count = chars.filter((c) => CLASSES[id].includes(c)).length;
          expect(count).toBeGreaterThanOrEqual(floors[id]);
        }
        expect(chars.length).toBe(Math.max(rules.length, required));
        if (rules.avoidAmbiguous) {
          expect(chars.some((c) => AMBIGUOUS.includes(c))).toBe(false);
        }
      }
    });
  }
});

describe("sphinxPassword is unbiased", () => {
  it("draws every character of a class about equally often", async () => {
    const rules: CharacterRules = {
      ...DEFAULT_RULES,
      length: 64,
      lower: true,
      upper: false,
      digits: false,
      symbols: false,
      avoidAmbiguous: true,
    };
    const alphabet = [...policy.classes.lower].filter(
      (c) => !policy.ambiguous.includes(c),
    );
    const counts = new Map(alphabet.map((c) => [c, 0]));
    const runs = 150;
    for (let counter = 0; counter < runs; counter += 1) {
      for (const c of await compute({ ...BASE, counter, rules })) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const expected = (runs * 64) / alphabet.length;
    let chi = 0;
    for (const count of counts.values())
      chi += (count - expected) ** 2 / expected;
    // df = 22; a 6-sigma bound, so a fair stream fails about never.
    expect(counts.size).toBe(alphabet.length);
    expect(chi).toBeLessThan(22 + 6 * Math.sqrt(2 * 22));
  });
});
