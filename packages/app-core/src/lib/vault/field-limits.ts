/**
 * The most a person can put in each kind of field.
 *
 * One table, so an editor input's `maxLength`, the path resolver and any other
 * writer read the same number. A cap is for the person: a name that is a
 * paragraph breaks the list, the tree and the title row before it breaks
 * anything else. Values already stored above a cap are never truncated; the
 * editor stops further typing and the path resolver refuses to write one back.
 */
export const FIELD_LIMITS = {
  /** An item's name, and one segment of a folder path. */
  name: 120,
  /** A folder's whole path, `Work/Projects/2026`. */
  folder: 240,
  /** A file type's extension, `.certificate`; the typeahead's query. */
  extension: 32,
  /** A short label: a custom field's name, a card brand. */
  label: 64,
  /** One line of text: a username, a relying party, a common name. */
  line: 256,
  /** A comma-separated list on one line: DNS names, IP addresses. */
  list: 1024,
  /** A website address or pattern. */
  uri: 2048,
  /** A concealed single-line value: a secret, a key code, a token. */
  secret: 4096,
  /** Free text: notes, a pasted key, a custom field's value. */
  text: 50_000,
  /** A card number, the longest a card scheme issues. */
  cardNumber: 19,
  /** Certificate lifetime in hours, up to six digits. */
  hours: 6,
} as const;

export type FieldLimit = keyof typeof FIELD_LIMITS;

/** Anything a path segment cannot carry: a separator, a control character. */
function hasControl(text: string): boolean {
  return [...text].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}

/**
 * Whether `path` can be a folder's name: non-empty segments of at most
 * `FIELD_LIMITS.name`, no `.` or `..`, no backslash or control character, and
 * no longer than `FIELD_LIMITS.folder` in all.
 */
export function isFolderPath(path: string): boolean {
  if (path === "" || path.length > FIELD_LIMITS.folder) return false;
  if (path.includes("\\") || hasControl(path)) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        segment.length <= FIELD_LIMITS.name,
    );
}

/**
 * Cut what a person typed into the name field to what it may hold. A typed
 * path is a folder prefix and a leaf: each is held to its own limit, so a
 * paste of `a/b/c` neither loses its leaf to a long prefix nor the reverse.
 */
export function clampTypedPath(text: string): string {
  const cut = text.lastIndexOf("/") + 1;
  return (
    text.slice(0, cut).slice(0, FIELD_LIMITS.folder) +
    text.slice(cut, cut + FIELD_LIMITS.name)
  );
}
