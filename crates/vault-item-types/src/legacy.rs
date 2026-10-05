//! Names that were renamed and still resolve (ADR 0166 §1).
//!
//! The `login` item type became `account`. Links and paths already handed out
//! (`?f=login`, `name.login`) keep working: the registry answers `login` with
//! the `account` definition and treats `.login` as the `account` extension.
//! This is the one place the Rust plane spells the old names; the same table
//! is `packages/vault-item-types/src/legacy-aliases.ts`, and both read
//! `legacyAliases` in `spec/conformance/item-type-cases.json` back in a test.
//!
//! An alias is never a type of its own: no definition may take it as an id or
//! claim it as an extension, or an install could dress its items as accounts.

/// Old type id → the type id that replaced it.
pub const LEGACY_TYPE_ALIASES: &[(&str, &str)] = &[("login", "account")];

/// Old VFS extension → the extension that replaced it.
pub const LEGACY_EXTENSION_ALIASES: &[(&str, &str)] = &[(".login", ".account")];

fn lookup<'a>(table: &[(&str, &'a str)], name: &str) -> Option<&'a str> {
    table
        .iter()
        .find(|(old, _)| *old == name)
        .map(|(_, current)| *current)
}

/// The current type id for `id`, which may be a legacy name.
#[must_use]
pub fn resolve_type_id(id: &str) -> &str {
    lookup(LEGACY_TYPE_ALIASES, id).unwrap_or(id)
}

/// The current extension for `extension`, which may be a legacy one.
#[must_use]
pub fn resolve_extension(extension: &str) -> &str {
    lookup(LEGACY_EXTENSION_ALIASES, extension).unwrap_or(extension)
}

/// True when `id` is a retired name rather than a type's own id.
#[must_use]
pub fn is_legacy_type_alias(id: &str) -> bool {
    lookup(LEGACY_TYPE_ALIASES, id).is_some()
}
