import type { Folder } from "@opensesame/vault-core";
import { isFolderPath } from "./field-limits.js";

/** One row of a typeahead list. `key` is what the owner of the list acts on. */
export type SuggestOption = {
  key: string;
  label: string;
  /** A second, quieter column: a type's title. */
  detail?: string;
  /** The row makes something that does not exist yet (a folder). */
  adding?: boolean;
};

export const ROOT_KEY = "root";
const FOLDER_PREFIX = "folder:";
const NEW_PREFIX = "new:";

export const folderKey = (id: string) => `${FOLDER_PREFIX}${id}`;
export const newFolderKey = (path: string) => `${NEW_PREFIX}${path}`;

export type FolderChoice =
  | { kind: "root" }
  | { kind: "folder"; id: string }
  | { kind: "new"; path: string };

export function parseFolderKey(key: string): FolderChoice | undefined {
  if (key === ROOT_KEY) return { kind: "root" };
  if (key.startsWith(FOLDER_PREFIX))
    return { kind: "folder", id: key.slice(FOLDER_PREFIX.length) };
  if (key.startsWith(NEW_PREFIX))
    return { kind: "new", path: key.slice(NEW_PREFIX.length) };
  return undefined;
}

/** What a person typed as a folder, as the path it names: `./a/b/` is `a/b`. */
export function folderQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/^\.$/, "")
    .replace(/\/+$/, "");
}

/** 0 for a prefix, 1 for a segment that starts with it, 2 for a substring. */
function rank(candidate: string, query: string): number {
  const text = candidate.toLowerCase();
  const needle = query.toLowerCase();
  if (text.startsWith(needle)) return 0;
  if (text.split("/").some((segment) => segment.startsWith(needle))) return 1;
  return text.includes(needle) ? 2 : -1;
}

/** Keep what matches `query`, best match first, ties in their given order. */
function matching<T>(
  items: readonly T[],
  query: string,
  texts: (item: T) => string[],
): T[] {
  if (query === "") return [...items];
  return items
    .map((item, order) => ({
      item,
      order,
      score: Math.min(
        ...texts(item)
          .map((text) => rank(text, query))
          .filter((value) => value >= 0),
        99,
      ),
    }))
    .filter((entry) => entry.score < 99)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.item);
}

/**
 * The folders to offer for what has been typed: the root, the folders whose
 * name matches, and — only when the text is a path a folder could have and no
 * folder has it — one row that makes it.
 */
export function folderSuggestions(
  folders: readonly Folder[],
  raw: string,
): SuggestOption[] {
  const query = folderQuery(raw);
  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  const found: SuggestOption[] = matching(sorted, query, (folder) => [
    folder.name,
  ]).map((folder) => ({
    key: folderKey(folder.id),
    label: `${folder.name}/`,
  }));
  const options: SuggestOption[] =
    query === "" ? [{ key: ROOT_KEY, label: "./" }, ...found] : found;
  const exists = folders.some(
    (folder) => folder.name.toLowerCase() === query.toLowerCase(),
  );
  if (query !== "" && !exists && isFolderPath(query))
    options.push({
      key: newFolderKey(query),
      label: `${query}/`,
      adding: true,
    });
  return options;
}

/** The option a typed folder names exactly, if there is one. */
export function exactFolder(
  folders: readonly Folder[],
  raw: string,
): SuggestOption | undefined {
  const query = folderQuery(raw);
  if (query === "") return { key: ROOT_KEY, label: "./" };
  const folder = folders.find(
    (entry) => entry.name.toLowerCase() === query.toLowerCase(),
  );
  return folder
    ? { key: folderKey(folder.id), label: `${folder.name}/` }
    : undefined;
}

export type TypeChoice = { id: string; extension: string; title: string };

/** What a person typed as a file type, without its dot, in lower case. */
export function typeQuery(raw: string): string {
  return raw.trim().replace(/^\.+/, "").toLowerCase();
}

/** The types whose extension, id or title matches what has been typed. */
export function typeSuggestions(
  types: readonly TypeChoice[],
  raw: string,
): SuggestOption[] {
  return matching(types, typeQuery(raw), (type) => [
    typeQuery(type.extension),
    type.id,
    type.title,
  ]).map((type) => ({
    key: type.id,
    label: type.extension,
    detail: type.title,
  }));
}

/** The type a typed extension names exactly, if there is one. */
export function exactType(
  types: readonly TypeChoice[],
  raw: string,
): SuggestOption | undefined {
  const query = typeQuery(raw);
  const type = types.find((entry) => typeQuery(entry.extension) === query);
  return type
    ? { key: type.id, label: type.extension, detail: type.title }
    : undefined;
}
