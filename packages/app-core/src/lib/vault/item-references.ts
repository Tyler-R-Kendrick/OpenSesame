import { type Assignment, renderEnv } from "../password-agent/env.js";

/**
 * An environment name for a reference: the item's name and the field's label,
 * upper-cased and joined with underscores, never starting with a digit.
 */
export function envNameFor(item: string, label: string): string {
  const joined = `${item} ${label}`
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  const name = joined || "CREDENTIAL";
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * The reference-only template for one item's references: `NAME=os://…`, one
 * line each, names made unique by a numeric suffix. It holds no value, so
 * building it asks nothing of the person.
 */
export function itemEnvTemplate(
  item: string,
  references: readonly { label: string; ref: string }[],
): string {
  const used = new Set<string>();
  const assignments: Assignment[] = references.map(({ label, ref }) => {
    const base = envNameFor(item, label);
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
    used.add(name);
    return { name, reference: ref };
  });
  return renderEnv(assignments);
}
