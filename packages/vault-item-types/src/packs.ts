/**
 * Built-in item types that arrive on demand (ADR 0164).
 *
 * The entry bundle embeds only the core types. Every other built-in is a
 * pack: a metadata entry that is always here (`PACK_INDEX`, enough to draw a
 * row and say how big the download is) and a definition that is not. Its text
 * lives in its own chunk, reached only through `fetchPackText`, so nothing is
 * fetched, parsed or registered until a person switches the type on.
 *
 * A pack is still a platform definition: same parser, same registry, same
 * right to name a handler, and the same JSON `crates/vault-item-types`
 * embeds. What a pack adds is the digest check between "fetched" and
 * "installed", so a chunk that is not the one this build indexed is refused.
 */

import { PACK_INDEX, PACK_LOADERS, type PackEntry } from "./packs.generated.js";
import type { ItemTypeDefinition } from "./schema.js";
import { describeErrors, parseDefinition } from "./validate.js";

export type { PackEntry } from "./packs.generated.js";

/** Why a pack could not be installed, in words a notice can carry. */
export class PackError extends Error {
  readonly reason: "unknown" | "fetch" | "digest" | "invalid";

  constructor(reason: PackError["reason"], message: string) {
    super(message);
    this.name = "PackError";
    this.reason = reason;
  }
}

export function packEntries(): readonly PackEntry[] {
  return PACK_INDEX;
}

export function packEntry(id: string): PackEntry | undefined {
  return PACK_INDEX.find((entry) => entry.id === id);
}

export function isPackId(id: string): boolean {
  return packEntry(id) !== undefined;
}

const loaded = new Map<string, ItemTypeDefinition>();
const texts = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Counts every register and drop. A registry built earlier compares it to
 * learn that its built-ins are stale, without subscribing to anything.
 */
export function packsVersion(): number {
  return version;
}

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The packs registered in this document, by id. */
export function loadedPacks(): ReadonlyMap<string, ItemTypeDefinition> {
  return loaded;
}

/** The authored text of a loaded pack, as the Settings file viewer shows it. */
export function loadedPackText(id: string): string | undefined {
  return texts.get(id);
}

export function isPackLoaded(id: string): boolean {
  return loaded.has(id);
}

/** Heard when a pack is registered or dropped. Returns the unsubscribe. */
export function subscribePacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How a pack's text is fetched. Tests and the CLI replace it. */
export type PackFetcher = (id: string) => Promise<string>;

/**
 * The default fetcher: a dynamic import of the pack's own chunk. Rejects with
 * a `PackError("fetch")` when the chunk cannot be had — offline, or a deploy
 * that moved the hashed file on.
 */
export const importPackText: PackFetcher = async (id) => {
  const load = PACK_LOADERS.get(id);
  if (load === undefined) {
    throw new PackError("unknown", `${id} is not a pack in this build.`);
  }
  try {
    return (await load()).default;
  } catch {
    throw new PackError("fetch", `The ${id} pack could not be downloaded.`);
  }
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Check fetched text against the index and parse it as a platform definition.
 * Nothing is registered: the caller decides when the type becomes real, so a
 * download can be abandoned between here and there.
 */
export async function verifyPackText(
  id: string,
  text: string,
): Promise<ItemTypeDefinition> {
  const entry = packEntry(id);
  if (entry === undefined) {
    throw new PackError("unknown", `${id} is not a pack in this build.`);
  }
  if ((await sha256Hex(text)) !== entry.sha256) {
    throw new PackError(
      "digest",
      `The ${entry.title} pack is not the one this build was made with.`,
    );
  }
  const parsed = parseDefinition(text, "platform");
  if (!parsed.ok) {
    throw new PackError(
      "invalid",
      `The ${entry.title} pack does not parse:\n${describeErrors(parsed.errors)}`,
    );
  }
  if (parsed.definition.metadata.id !== id) {
    throw new PackError(
      "invalid",
      `The ${entry.title} pack declares ${parsed.definition.metadata.id}.`,
    );
  }
  return parsed.definition;
}

/** Make a verified definition real for this document. Idempotent. */
export function registerPack(
  definition: ItemTypeDefinition,
  text: string,
): void {
  const id = definition.metadata.id;
  if (!isPackId(id)) return;
  if (loaded.get(id) === definition) return;
  loaded.set(id, definition);
  texts.set(id, text);
  emit();
}

/** Forget a pack. Items of that type keep every value they hold. */
export function dropPack(id: string): boolean {
  if (!loaded.delete(id)) return false;
  texts.delete(id);
  emit();
  return true;
}

/** Fetch, verify and register one pack. */
export async function loadPack(
  id: string,
  fetchText: PackFetcher = importPackText,
): Promise<ItemTypeDefinition> {
  const existing = loaded.get(id);
  if (existing !== undefined) return existing;
  const text = await fetchText(id);
  const definition = await verifyPackText(id, text);
  registerPack(definition, text);
  return definition;
}
