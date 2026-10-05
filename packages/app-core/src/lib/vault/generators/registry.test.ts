import { DEFAULT_RULES, deriveCharacters } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { WORDS } from "../password.js";
import {
  GENERATORS,
  defaultGenerator,
  generateStored,
  generatorEntropyBits,
  newSecretFor,
  offeredGenerators,
} from "./index.js";

describe("GENERATORS", () => {
  it("lists derived first, then rules, passphrase, manual", () => {
    expect(GENERATORS.map((g) => g.id)).toEqual([
      "derived",
      "rules",
      "passphrase",
      "manual",
    ]);
    expect(GENERATORS.map((g) => g.label)).toEqual([
      "Algorithmic",
      "Random characters",
      "Random words",
      "My own",
    ]);
  });

  it("names a kind of generator, never the technique behind one", () => {
    const shown = [
      ...GENERATORS.map((g) => g.label),
      offeredGenerators("sphinx").at(-1)?.label ?? "",
    ].join(" ");
    expect(shown).not.toMatch(
      /hkdf|sha|argon|opaque|sphinx|oprf|pbkdf|derive/i,
    );
  });

  it("says what each produces", () => {
    expect(GENERATORS.map((g) => g.produces)).toEqual([
      "derived",
      "stored",
      "stored",
      "typed",
    ]);
  });

  it("adds the earlier Sphinx row only for a method that already uses it", () => {
    expect(offeredGenerators("rules")).toBe(GENERATORS);
    const withSphinx = offeredGenerators("sphinx");
    expect(withSphinx.map((g) => g.id)).toEqual([
      ...GENERATORS.map((g) => g.id),
      "sphinx",
    ]);
    expect(withSphinx.at(-1)).toMatchObject({
      label: "Algorithmic (earlier)",
    });
  });
});

describe("defaultGenerator", () => {
  it("gives each id its default shape", () => {
    expect(defaultGenerator("derived")).toEqual({
      id: "derived",
      rules: DEFAULT_RULES,
      counter: 0,
    });
    expect(defaultGenerator("rules")).toEqual({
      id: "rules",
      ...DEFAULT_RULES,
    });
    expect(defaultGenerator("passphrase")).toEqual({
      id: "passphrase",
      words: 4,
      separator: "-",
      capitalize: true,
      includeNumber: true,
    });
    expect(defaultGenerator("manual")).toEqual({ id: "manual" });
  });

  it("gives every call its own rules, so editing one never edits the default", () => {
    const a = defaultGenerator("derived");
    const b = defaultGenerator("derived");
    if (a.id !== "derived" || b.id !== "derived") throw new Error("shape");
    expect(a.rules).not.toBe(b.rules);
    a.rules.length = 99;
    expect(b.rules.length).toBe(DEFAULT_RULES.length);
  });
});

describe("generateStored", () => {
  it("makes a password for the rules and passphrase generators", () => {
    const rules = defaultGenerator("rules");
    const phrase = defaultGenerator("passphrase");
    if (rules.id !== "rules" || phrase.id !== "passphrase")
      throw new Error("shape");
    expect(generateStored(rules)).toHaveLength(DEFAULT_RULES.length);
    expect(generateStored(phrase).split("-")).toHaveLength(4);
  });
});

describe("generatorEntropyBits", () => {
  it("is exact for rules, counting the alphabet and the effective length", () => {
    const rules = {
      id: "rules" as const,
      ...DEFAULT_RULES,
      avoidAmbiguous: false,
      length: 10,
      upper: false,
      digits: false,
      symbols: false,
    };
    expect(generatorEntropyBits(rules)).toBe(Math.round(10 * Math.log2(26)));
    expect(
      generatorEntropyBits({
        ...rules,
        lower: true,
        digits: true,
        minDigits: 12,
        length: 4,
      }),
    ).toBe(Math.round(13 * Math.log2(36)));
  });

  it("is words times the list's bits, plus a digit when asked, for passphrases", () => {
    const base = {
      id: "passphrase" as const,
      words: 5,
      separator: "-",
      capitalize: false,
      includeNumber: false,
    };
    expect(generatorEntropyBits(base)).toBe(
      Math.round(5 * Math.log2(WORDS.length)),
    );
    expect(generatorEntropyBits({ ...base, includeNumber: true })).toBe(
      Math.round(5 * Math.log2(WORDS.length) + Math.log2(10)),
    );
  });

  it("reads a derived or earlier sphinx generator by the shape it encodes into, and is null for manual", () => {
    const rules = { ...DEFAULT_RULES, length: 24 };
    const same = generatorEntropyBits({ id: "rules", ...rules });
    expect(generatorEntropyBits({ id: "derived", rules, counter: 3 })).toBe(
      same,
    );
    expect(
      generatorEntropyBits({
        id: "sphinx",
        rules,
        realm: "r",
        counter: 0,
        oprfKeyB64: "k",
      }),
    ).toBe(same);
    expect(generatorEntropyBits({ id: "manual" })).toBeNull();
  });
});

describe("newSecretFor", () => {
  it("is a root for an algorithmic generator, a password for a random one, nothing for a typed one", () => {
    const root = newSecretFor(defaultGenerator("derived"));
    expect(root).toHaveLength(44);
    expect(root).not.toBe(newSecretFor(defaultGenerator("derived")));
    expect(deriveCharacters(root, 0, DEFAULT_RULES)).toHaveLength(20);
    expect(newSecretFor(defaultGenerator("rules"))).toHaveLength(20);
    expect(newSecretFor(defaultGenerator("passphrase"))).toMatch(/-/);
    expect(newSecretFor(defaultGenerator("manual"))).toBe("");
  });
});
