/**
 * Names that were renamed and still resolve (ADR 0166 §1).
 *
 * The `login` item type became `account`. Links (`/vault/new/login`, `?f=login`)
 * and paths (`name.login`) that were already handed out keep working: the
 * registry answers `login` with the `account` definition and treats `.login`
 * as the `account` extension. This is the one place the old names are spelled;
 * `crates/vault-item-types/src/legacy.rs` carries the same table, and a test in
 * each plane reads it back.
 *
 * An alias is never a type of its own: no definition may take it as an id or
 * claim it as an extension, or an install could dress its items as accounts.
 */

/** Old type id → the type id that replaced it. */
export const LEGACY_TYPE_ALIASES: Readonly<Record<string, string>> = {
  login: "account",
};

/** Old VFS extension → the extension that replaced it. */
export const LEGACY_EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  ".login": ".account",
};

/** The current type id for `id`, which may be a legacy name. */
export function resolveTypeId(id: string): string {
  return Object.hasOwn(LEGACY_TYPE_ALIASES, id)
    ? (LEGACY_TYPE_ALIASES[id] ?? id)
    : id;
}

/** The current extension for `extension`, which may be a legacy one. */
export function resolveExtension(extension: string): string {
  return Object.hasOwn(LEGACY_EXTENSION_ALIASES, extension)
    ? (LEGACY_EXTENSION_ALIASES[extension] ?? extension)
    : extension;
}

/** True when `id` is a retired name rather than a type's own id. */
export function isLegacyTypeAlias(id: string): boolean {
  return Object.hasOwn(LEGACY_TYPE_ALIASES, id);
}
