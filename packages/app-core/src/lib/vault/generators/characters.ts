/**
 * The one character-password builder (ADR 0171). It is parameterised by where
 * its uniform draws come from: `rules` draws them from `crypto.getRandomValues`,
 * `sphinx` from a stream expanded out of the OPRF output. The pools are the
 * ones every target shares (`spec/conformance/password-policy.json`, via
 * `password.ts`).
 *
 * Each selected class contributes at least one character (and at least
 * `minDigits` / `minSymbols` for those two), the rest are drawn from the union
 * of the selected classes, and the result is shuffled with Fisher-Yates driven
 * by the same source.
 */

import type { CharacterRules } from "@opensesame/vault-core";
import { characterPools } from "../password.js";

/** A source of uniform integers. `index(max)` is uniform in `[0, max)`. */
export type IndexSource = { index(max: number): number };

/** Longest password the builder will make. */
export const MAX_PASSWORD_LENGTH = 256;

/** A per-class floor is capped so four floors still fit the longest password. */
const MAX_FLOOR = MAX_PASSWORD_LENGTH / 4;

type PoolClass = "lower" | "upper" | "digits" | "symbols";

type ClassPool = { id: PoolClass; chars: string; floor: number };

const CLASS_IDS: readonly PoolClass[] = ["lower", "upper", "digits", "symbols"];

function classPool(rules: CharacterRules, id: PoolClass): ClassPool | null {
  if (!rules[id]) return null;
  const only = { lower: false, upper: false, digits: false, symbols: false };
  const [chars] = characterPools({
    mode: "characters",
    length: 1,
    ...only,
    [id]: true,
    avoidAmbiguous: rules.avoidAmbiguous,
  });
  if (chars === undefined) return null;
  const asked =
    id === "digits" ? rules.minDigits : id === "symbols" ? rules.minSymbols : 0;
  const floor = Math.min(MAX_FLOOR, Math.max(1, Math.floor(asked) || 0));
  return { id, chars, floor };
}

function classPools(rules: CharacterRules): ClassPool[] {
  const pools: ClassPool[] = [];
  for (const id of CLASS_IDS) {
    const pool = classPool(rules, id);
    if (pool) pools.push(pool);
  }
  if (pools.length === 0) throw new Error("Choose at least one character set.");
  return pools;
}

/** The characters the rules draw from, per class, with the ambiguous set applied. */
export function ruleAlphabet(rules: CharacterRules): string {
  return classPools(rules)
    .map((pool) => pool.chars)
    .join("");
}

/** The length a password under these rules really has: floors can lengthen it. */
export function effectiveLength(rules: CharacterRules): number {
  const floors = classPools(rules).reduce((sum, pool) => sum + pool.floor, 0);
  const asked = Number.isFinite(rules.length) ? Math.floor(rules.length) : 0;
  return Math.max(Math.min(MAX_PASSWORD_LENGTH, asked), floors);
}

function draw(source: IndexSource, alphabet: string): string {
  return alphabet.charAt(source.index(alphabet.length));
}

export function buildCharacters(
  rules: CharacterRules,
  source: IndexSource,
): string {
  const pools = classPools(rules);
  const union = pools.map((pool) => pool.chars).join("");
  const length = effectiveLength(rules);
  const out: string[] = [];
  for (const pool of pools) {
    for (let n = 0; n < pool.floor; n += 1) out.push(draw(source, pool.chars));
  }
  while (out.length < length) out.push(draw(source, union));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = source.index(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined)
      throw new Error("shuffle out of range");
    out[i] = b;
    out[j] = a;
  }
  return out.join("");
}
