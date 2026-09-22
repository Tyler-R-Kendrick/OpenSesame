/**
 * Loader table: capability id → module chunk + asset ids.
 *
 * Pure reader over the table the build plugin (vite.composition.ts)
 * generates. assertKnown fails closed on unknown ids — a loader that
 * cannot name a module must refuse, never guess.
 */

export type LoaderEntry = {
  readonly id: string;
  readonly moduleIds: readonly string[];
  readonly assetIds: readonly string[];
};

export type LoaderTable = {
  readonly generatedAt: string;
  readonly entries: readonly LoaderEntry[];
};

/** All entries keyed by capability id. */
export function entries(table: LoaderTable): ReadonlyMap<string, LoaderEntry> {
  return new Map(table.entries.map((e) => [e.id, e]));
}

/** Module ids for a known capability; throws on unknown ids. */
export function modulesFor(table: LoaderTable, id: string): readonly string[] {
  return assertKnown(table, id).moduleIds;
}

/** The entry for an id, or throws when the table never shipped it. */
export function assertKnown(table: LoaderTable, id: string): LoaderEntry {
  const entry = entries(table).get(id);
  if (!entry) throw new Error(`loader table has no module for ${id}`);
  return entry;
}

/** Loader tables cross the build boundary as JSON; accept the parsed shape. */
export function isLoaderTable(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return false;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return false;
    const { id, moduleIds, assetIds } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return false;
    if (!Array.isArray(moduleIds) || moduleIds.length === 0) return false;
    if (!Array.isArray(assetIds)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
