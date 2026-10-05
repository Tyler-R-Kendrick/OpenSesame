/**
 * The `rules` generator: random characters under length, classes, avoid
 * ambiguous, and Bitwarden-style minimum digits and symbols (ADR 0171 §3).
 * Randomness is `crypto.getRandomValues` with rejection sampling, as in
 * `password.ts`.
 */

import type { RulesGenerator } from "@opensesame/vault-core";
import { type IndexSource, buildCharacters } from "./characters.js";

/** Uniform index in [0, max) without modulo bias. */
function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIndex needs a positive bound");
  }
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

export const cryptoSource: IndexSource = { index: randomIndex };

export function generateRules(generator: RulesGenerator): string {
  const { id: _id, ...rules } = generator;
  return buildCharacters(rules, cryptoSource);
}
