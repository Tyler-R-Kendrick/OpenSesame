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
import { PACK_INDEX } from "./packs.generated.js";
import { loadedPacks } from "./packs.js";
import { ItemTypeRegistry } from "./registry.js";
import type { ItemTypeDefinition } from "./schema.js";
import { describeErrors, parseDefinition } from "./validate.js";

/** The embedded (core) definitions as `[id, JSON]`, in a stable order. */
const BUILTIN_ENTRIES: readonly (readonly [string, string])[] = Object.entries(
  BUILTIN_DEFINITION_JSON,
).sort(([left], [right]) => left.localeCompare(right));

/** The ids that are always embedded: the entry bundle carries their text. */
export const CORE_TYPE_IDS: readonly string[] = BUILTIN_ENTRIES.map(
  ([id]) => id,
);

/**
 * Every built-in id, core and pack alike, in a stable order. Ids are known
 * without the packs being loaded — the index is metadata — so a screen can
 * gate on "is this a built-in kind" before any definition has arrived.
 */
export const BUILTIN_TYPE_IDS: readonly string[] = [
  ...CORE_TYPE_IDS,
  ...PACK_INDEX.map((entry) => entry.id),
].sort((left, right) => left.localeCompare(right));

/**
 * The seven ids that predate ADR 0087 and are still spelled out in
 * `apps/pages` storage (`login` is `account` since ADR 0166; the old name
 * resolves through `legacy-aliases.ts`). Kept here so the legacy union and the
 * corpus cannot drift apart without a test noticing.
 */
export const LEGACY_TYPE_IDS: readonly string[] = [
  "account",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

/**
 * The built-ins this document holds: the embedded core and whichever packs
 * have been loaded. A pack that has not been switched on is not here.
 */
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
  for (const definition of loadedPacks().values()) out.push(definition);
  return out;
}

/** A registry holding the built-ins this document has, and nothing else. */
export function builtinRegistry(): ItemTypeRegistry {
  const registry = new ItemTypeRegistry();
  for (const definition of builtinDefinitions()) {
    registry.registerBuiltin(definition);
  }
  return registry;
}
