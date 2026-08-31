/**
 * The built-in corpus, loaded through the same registry as anything else.
 *
 * A built-in's only privileges are a reserved id and the right to name a
 * ceremony handler (ADR 0087 §1/§6). It is otherwise an ordinary definition,
 * parsed by the ordinary parser — which is the dogfooding claim made
 * executable: if the generic path could not carry `card` or `note`, this file
 * would not load.
 */

import { BUILTIN_DEFINITION_JSON } from "./definitions.generated.js";
import { ItemTypeRegistry } from "./registry.js";
import type { ItemTypeDefinition } from "./schema.js";
import { describeErrors, parseDefinition } from "./validate.js";

/** Every built-in definition as `[id, JSON]`, in a stable order. */
const BUILTIN_ENTRIES: readonly (readonly [string, string])[] = Object.entries(
  BUILTIN_DEFINITION_JSON,
).sort(([left], [right]) => left.localeCompare(right));

export const BUILTIN_TYPE_IDS: readonly string[] = BUILTIN_ENTRIES.map(
  ([id]) => id,
);

/**
 * The seven ids that predate ADR 0087 and are still spelled out in
 * `apps/pages` storage. Kept here so the legacy union and the corpus cannot
 * drift apart without a test noticing.
 */
export const LEGACY_TYPE_IDS: readonly string[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

export function builtinDefinitions(): readonly ItemTypeDefinition[] {
  const out: ItemTypeDefinition[] = [];
  for (const [id, text] of BUILTIN_ENTRIES) {
    const parsed = parseDefinition(text, "platform");
    if (!parsed.ok) {
      // A corpus that does not parse is a build error, not a runtime state:
      // these files ship with the client and a test parses every one of them.
      throw new Error(
        `built-in item type \`${id}\` is invalid:\n${describeErrors(parsed.errors)}`,
      );
    }
    if (parsed.definition.metadata.id !== id) {
      throw new Error(
        `built-in item type file \`${id}.json\` declares id \`${parsed.definition.metadata.id}\``,
      );
    }
    out.push(parsed.definition);
  }
  return out;
}

/** A registry holding the built-in corpus and nothing else. */
export function builtinRegistry(): ItemTypeRegistry {
  const registry = new ItemTypeRegistry();
  for (const definition of builtinDefinitions()) {
    registry.registerBuiltin(definition);
  }
  return registry;
}
