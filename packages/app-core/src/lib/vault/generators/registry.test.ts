import { DEFAULT_RULES } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { WORDS } from "../password.js";
import {
  GENERATORS,
  defaultGenerator,
  generateStored,
  generatorEntropyBits,
} from "./index.js";

describe("GENERATORS", () => {
  it("lists rules, passphrase, sphinx, manual in that order", () => {
    expect(GENERATORS.map((g) => g.id)).toEqual([
      "rules",
      "passphrase",
      "sphinx",
      "manual",
    ]);
    expect(GENERATORS.map((g) => g.label)).toEqual([
      "Rules",
      "Passphrase",
      "Sphinx",
      "Manual",
    ]);
  });

  it("offers the pepper flag for every generator but sphinx", () => {
    const flags = Object.fromEntries(
      GENERATORS.map((g) => [g.id, g.offersPepperFlag]),
    );
    expect(flags).toEqual({
      rules: true,
      passphrase: true,
      sphinx: false,
      manual: true,
    });
  });

  it("says what each produces", () => {
    expect(GENERATORS.map((g) => g.produces)).toEqual([
      "stored",
      "stored",
      "derived",
      "typed",
    ]);
  });
});

describe("defaultGenerator", () => {
  const context = { realm: "example.com" };

  it("gives each id its default shape", () => {
    expect(defaultGenerator("rules", context)).toEqual({
      id: "rules",
      ...DEFAULT_RULES,
    });
    expect(defaultGenerator("passphrase", context)).toEqual({
      id: "passphrase",
      words: 4,
      separator: "-",
      capitalize: true,
      includeNumber: true,
    });
    expect(defaultGenerator("manual", context)).toEqual({ id: "manual" });
  });

  it("mints a fresh sphinx key, counter zero and the realm, every call", () => {
    const a = defaultGenerator("sphinx", context);
    const b = defaultGenerator("sphinx", context);
    if (a.id !== "sphinx" || b.id !== "sphinx")
      throw new Error("expected sphinx");
    expect(a.oprfKeyB64).not.toBe(b.oprfKeyB64);
    expect(a.oprfKeyB64.length).toBeGreaterThan(40);
    expect(a).toMatchObject({
      counter: 0,
      realm: "example.com",
      rules: DEFAULT_RULES,
    });
  });
});

describe("generateStored", () => {
  it("makes a password for the rules and passphrase generators", () => {
    const rules = defaultGenerator("rules", { realm: "r" });
    const phrase = defaultGenerator("passphrase", { realm: "r" });
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

  it("reads a sphinx generator by the shape it encodes into, and is null for manual", () => {
    const sphinx = defaultGenerator("sphinx", { realm: "r" });
    if (sphinx.id !== "sphinx") throw new Error("shape");
    expect(generatorEntropyBits(sphinx)).toBe(
      generatorEntropyBits({ id: "rules", ...sphinx.rules }),
    );
    expect(generatorEntropyBits({ id: "manual" })).toBeNull();
  });
});
