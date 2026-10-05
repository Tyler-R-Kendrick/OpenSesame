/**
 * Which viewport sizes `verify:mobile` walks.
 *
 * `MOBILE_SIZES=320,390` walks only the named sizes, so CI can run the journey
 * as parallel shards of one build. Unset it walks every size, as a person
 * running it locally expects. A name that matches no size is an error: a shard
 * that walked nothing would pass and prove nothing.
 */
import { PHONES, TABLETS } from "./mobile-contract.mjs";

export function sizesToWalk(env, { phones = PHONES, tablets = TABLETS } = {}) {
  const named = (env ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (named.length === 0) return { phones, tablets };
  const known = [...phones, ...tablets].map((size) => size.name);
  const unknown = named.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `MOBILE_SIZES names no size called ${unknown.join(", ")} (known: ${known.join(", ")})`,
    );
  }
  return {
    phones: phones.filter((size) => named.includes(size.name)),
    tablets: tablets.filter((size) => named.includes(size.name)),
  };
}
