/**
 * Names that were renamed and still resolve (ADR 0171 §1).
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
export const LEGACY_TYPE_ALIASES = {
  login: "account",
} as const satisfies Readonly<Record<string, string>>;

/** Old VFS extension → the extension that replaced it. */
export const LEGACY_EXTENSION_ALIASES = {
  ".login": ".account",
} as const satisfies Readonly<Record<string, string>>;

/** What a table of retired names says replaced `key`, when it names it. */
function aliasOf(
  table: readonly (readonly [string, string])[],
  key: string,
): string | undefined {
  return table.find(([retired]) => retired === key)?.[1];
}

/** The current type id for `id`, which may be a legacy name. */
export function resolveTypeId(id: string): string {
  return aliasOf(Object.entries(LEGACY_TYPE_ALIASES), id) ?? id;
}

/** The current extension for `extension`, which may be a legacy one. */
export function resolveExtension(extension: string): string {
  return (
    aliasOf(Object.entries(LEGACY_EXTENSION_ALIASES), extension) ?? extension
  );
}

/** True when `id` is a retired name rather than a type's own id. */
export function isLegacyTypeAlias(id: string): boolean {
  return aliasOf(Object.entries(LEGACY_TYPE_ALIASES), id) !== undefined;
}
