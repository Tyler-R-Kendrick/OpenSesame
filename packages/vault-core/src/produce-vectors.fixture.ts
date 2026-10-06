/**
 * The inputs of `spec/conformance/produce-vectors.json` (ADR 0139, ADR 0174).
 * The expected outputs are what `producePassword` and `splitAtPepper` return
 * for them, written once by `produce-vectors.emit.test.ts` and then read by that
 * facade here and by `crates/sealed-store/src/produce.rs`: the two must agree
 * byte for byte. Synthetic data only; never regenerate to make a test pass.
 */

import { type CharacterRules, DEFAULT_RULES } from "./account.js";

/** A fixed root: the bytes 0..31, base64. Not a credential. */
export const VECTOR_ROOT = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
/** A second root, so one root's password is not another's. */
export const OTHER_ROOT = "H8DxEGDhP0xZ7sB5RnFfXTq3KkYj4m0hQ1y2z3A4B5c=";

function rules(over: Partial<CharacterRules> = {}): CharacterRules {
  return { ...DEFAULT_RULES, ...over };
}

export type DerivedCase = {
  name: string;
  root: string;
  counter: number;
  rules: CharacterRules;
};

export const DERIVED_CASES: DerivedCase[] = [
  { name: "the defaults", root: VECTOR_ROOT, counter: 0, rules: rules() },
  { name: "the next counter", root: VECTOR_ROOT, counter: 1, rules: rules() },
  { name: "another root", root: OTHER_ROOT, counter: 0, rules: rules() },
  {
    name: "the largest counter",
    root: VECTOR_ROOT,
    counter: 0xffffffff,
    rules: rules(),
  },
  {
    name: "letters and numbers only",
    root: VECTOR_ROOT,
    counter: 3,
    rules: rules({ symbols: false, avoidAmbiguous: false }),
  },
  {
    name: "digits only",
    root: VECTOR_ROOT,
    counter: 0,
    rules: rules({ lower: false, upper: false, symbols: false, length: 12 }),
  },
  {
    name: "floors for numbers and symbols",
    root: VECTOR_ROOT,
    counter: 0,
    rules: rules({ minDigits: 6, minSymbols: 5, length: 16 }),
  },
  {
    name: "floors that lengthen it",
    root: VECTOR_ROOT,
    counter: 0,
    rules: rules({ minDigits: 10, minSymbols: 10, length: 8 }),
  },
  {
    name: "the shortest and the longest",
    root: OTHER_ROOT,
    counter: 7,
    rules: rules({ length: 8 }),
  },
  {
    name: "sixty-four long, ambiguous allowed",
    root: OTHER_ROOT,
    counter: 7,
    rules: rules({ length: 64, avoidAmbiguous: false }),
  },
  {
    name: "past the cap",
    root: OTHER_ROOT,
    counter: 0,
    rules: rules({ length: 400 }),
  },
];

export type PositionCase = { expression: string };

/** Where a pepper goes in `abcdefghij`, for every shape of expression. */
export const POSITION_PASSWORD = "abcdefghij";
export const POSITION_CASES: string[] = [
  "",
  "end",
  "0",
  "3",
  "10",
  "99",
  "-1",
  "-3",
  "-10",
  "-99",
  "2:5",
  ":4",
  "-3:",
  "[2:5]",
  " 2 : 5 ",
  ":",
  "-4:-1",
  "5:2",
  "3:3",
  "8:99",
  "-99:2",
  "middle",
  "1:2:3",
  "1.5",
  "+2",
];
