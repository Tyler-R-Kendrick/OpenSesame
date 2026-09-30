/**
 * Built-in item types other than the base secret (ADR 0153).
 *
 * `secret` is the only kind the minimal vault creates. Every other built-in
 * type projects onto that same native secret (`spec.native` in the corpus,
 * ADR 0087). Passkey, certificate and drop keep their own capabilities; the
 * rest belong to `vault.derived-records` and stay out of a plan until that
 * capability is on.
 */

import { BUILTIN_TYPE_IDS } from "@opensesame/vault-item-types";

const OWNED_ELSEWHERE: ReadonlySet<string> = new Set([
  "secret",
  "passkey",
  "certificate",
  "drop",
]);

/** Legacy rail orders. Later derived types follow, in id order. */
const LEGACY_ORDER: Readonly<Record<string, number>> = {
  login: 0,
  card: 30,
  note: 60,
};

/** Directory names the rail already used for the kinds that used to be core. */
const LEGACY_SEGMENT: Readonly<Record<string, string>> = {
  login: "logins",
  card: "cards",
  note: "notes",
};

export const DERIVED_ITEM_KINDS: readonly string[] = BUILTIN_TYPE_IDS.filter(
  (id) => !OWNED_ELSEWHERE.has(id),
);

export function derivedKindOrder(id: string, index: number): number {
  return LEGACY_ORDER[id] ?? 80 + index;
}

export function derivedKindSegment(id: string, fallback: string): string {
  return LEGACY_SEGMENT[id] ?? fallback;
}
