/**
 * The runtime item-type registry (ADR 0087 §7).
 *
 * Three sources, first match wins: the builtin corpus embedded in this
 * package, definitions installed into the sealed vault body (which is how they
 * sync E2EE to a user's other devices), and a host-plane directory for the
 * CLI. Installing and uninstalling are data writes — no build, no restart, on
 * any of the three.
 *
 * Uninstalling never touches items. An item whose type is not installed here
 * is a presentation gap, never data loss: `mergeVaultBodies` is
 * last-writer-wins per item, so a client that coerced unknown items into notes
 * would destroy them on every other device.
 */

import type { ItemTypeDefinition } from "./schema.js";
import {
  type DefinitionError,
  type DefinitionTrust,
  parseDefinition,
} from "./validate.js";

export type DefinitionSource = "builtin" | "vault" | "host";

export type RegisteredType = {
  readonly definition: ItemTypeDefinition;
  readonly source: DefinitionSource;
};

export type InstallOutcome =
  | { readonly ok: true; readonly definition: ItemTypeDefinition }
  | { readonly ok: false; readonly errors: readonly DefinitionError[] };

function refusal(
  code: DefinitionError["code"],
  path: string,
  message: string,
): InstallOutcome {
  return { ok: false, errors: [{ code, path, message }] };
}

function compareVersions(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const a = l[index] ?? 0;
    const b = r[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export class ItemTypeRegistry {
  readonly #builtin = new Map<string, ItemTypeDefinition>();
  readonly #installed = new Map<string, RegisteredType>();

  /** Register the platform's own corpus. Only these may name a handler. */
  registerBuiltin(definition: ItemTypeDefinition): void {
    this.#builtin.set(definition.metadata.id, definition);
  }

  /**
   * Install a definition from JSON text.
   *
   * A builtin id may not be shadowed and a publisher may not take over an id
   * another publisher installed: identity is `publisher + id`, never a bare
   * name a later install can redefine underneath items that already exist.
   */
  install(text: string, source: DefinitionSource): InstallOutcome {
    const trust: DefinitionTrust =
      source === "builtin" ? "platform" : "community";
    const parsed = parseDefinition(text, trust);
    if (!parsed.ok) return parsed;
    const { definition } = parsed;
    const id = definition.metadata.id;

    if (source === "builtin") {
      this.registerBuiltin(definition);
      return { ok: true, definition };
    }
    if (this.#builtin.has(id)) {
      return refusal(
        "id",
        "metadata.id",
        `\`${id}\` is a built-in type and cannot be redefined`,
      );
    }
    // The VFS tree renders an item as `name.ext` (ADR 0064/0073), so the
    // extension is the second thing that identifies a type on screen. Letting
    // an install claim `.login` would let it dress its items as logins — the
    // same impersonation the built-in id rule already refuses.
    const clash = this.#extensionOwner(definition.spec.extension, id);
    if (clash !== undefined) {
      return refusal(
        "extension",
        "spec.extension",
        `\`${definition.spec.extension}\` is already used by \`${clash}\``,
      );
    }
    const current = this.#installed.get(id);
    if (
      current !== undefined &&
      current.definition.metadata.publisher !== definition.metadata.publisher
    ) {
      return refusal(
        "publisher",
        "metadata.publisher",
        `\`${id}\` is already installed from ${current.definition.metadata.publisher}`,
      );
    }
    if (
      current !== undefined &&
      compareVersions(
        definition.metadata.version,
        current.definition.metadata.version,
      ) < 0
    ) {
      return refusal(
        "version",
        "metadata.version",
        `\`${id}\` is already installed at ${current.definition.metadata.version}`,
      );
    }
    this.#installed.set(id, { definition, source });
    return { ok: true, definition };
  }

  /** The type already rendering this extension, if it is not `self`. */
  #extensionOwner(extension: string, self: string): string | undefined {
    for (const [id, definition] of this.#builtin) {
      if (id !== self && definition.spec.extension === extension) return id;
    }
    for (const [id, entry] of this.#installed) {
      if (id !== self && entry.definition.spec.extension === extension) {
        return id;
      }
    }
    return undefined;
  }

  /** Remove an installed definition. Items of that type are left alone. */
  uninstall(id: string): boolean {
    return this.#installed.delete(id);
  }

  get(id: string): ItemTypeDefinition | undefined {
    return this.#builtin.get(id) ?? this.#installed.get(id)?.definition;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  sourceOf(id: string): DefinitionSource | undefined {
    if (this.#builtin.has(id)) return "builtin";
    return this.#installed.get(id)?.source;
  }

  isBuiltin(id: string): boolean {
    return this.#builtin.has(id);
  }

  /** Every registered type, builtins first, each group by title. */
  list(): readonly RegisteredType[] {
    const byTitle = (a: RegisteredType, b: RegisteredType) =>
      a.definition.spec.title.localeCompare(
        b.definition.spec.title,
        undefined,
        {
          sensitivity: "base",
        },
      );
    const builtins = [...this.#builtin.values()]
      .map((definition) => ({ definition, source: "builtin" as const }))
      .sort(byTitle);
    const installed = [...this.#installed.values()].sort(byTitle);
    return [...builtins, ...installed];
  }

  /** Installed definitions only — what a caller persists into the vault. */
  installed(): readonly ItemTypeDefinition[] {
    return [...this.#installed.values()]
      .filter((entry) => entry.source === "vault")
      .map((entry) => entry.definition);
  }

  /** Type ids grouped by their declared categories, for a type picker. */
  categories(): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const { definition } of this.list()) {
      const categories =
        definition.spec.categories.length > 0
          ? definition.spec.categories
          : ["other"];
      for (const category of categories) {
        const ids = grouped.get(category) ?? [];
        ids.push(definition.metadata.id);
        grouped.set(category, ids);
      }
    }
    return grouped;
  }
}
