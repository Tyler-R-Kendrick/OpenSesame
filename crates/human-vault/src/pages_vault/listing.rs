//! What a vault file may show once it is open: the tomb, the binding, the
//! revision against the header's, and each item's name, kind and path as the
//! vault tree lists it (`buildRows` in `packages/vault-core`) — never a field
//! value.

use std::collections::HashMap;

use super::{
    body::{FolderMeta, ItemMeta, OpenedBody},
    envelope::{SealedVaultFile, VaultFileFormat},
    pin::is_js_space,
};

/// The path a vault's device identity key is listed under (ADR 0160 §5): the
/// name and nothing of the key. Mirrors `DEVICE_IDENTITY_KEY_PATH` in
/// `packages/vault-core`.
pub const DEVICE_IDENTITY_KEY_PATH: &str = "config/device-identity-key";

/// Resolves an item type id to its extension (`.account`), when the caller has
/// a registry; `None` falls back as `typeExtension` does.
pub type ExtensionOf<'a> = &'a dyn Fn(&str) -> Option<String>;

/// One item as listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFileEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// Where the vault tree lists it: `Folder/name.ext` or `name.ext`.
    pub path: String,
}

/// A vault file read down to what may be shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedVaultFile {
    pub format: VaultFileFormat,
    pub tomb: String,
    /// The body is sealed to this tomb (`false`: a legacy unbound body).
    pub bound: bool,
    /// The sealed body's `rev`.
    pub rev: Option<u64>,
    /// The header's `bodyRev`: the highest revision the writer recorded.
    pub header_rev: Option<u64>,
    /// The body is older than the header records (§3): a rollback, reported
    /// and never repaired.
    pub rolled_back: bool,
    pub folders: usize,
    pub items: Vec<VaultFileEntry>,
    /// Files the body carries whose value is never shown, by path alone: the
    /// device identity key, when the vault holds one.
    pub concealed: Vec<String>,
}

/// The built-in extensions of the legacy kinds (`KIND_EXT`), the reader's
/// default when no item-type registry is at hand.
///
/// `account` is the kind Pages writes since ADR 0172 and lists as `.account`.
/// A vault Pages has not opened since then still holds `login` items, which
/// Pages normalizes to accounts on open; this reader never writes, so it lists
/// them as they are, `.login`. Both rows are spelled here, not derived: this
/// crate does not read the item-type corpus, and `login_is_listed_beside_account`
/// pins them against `marketplace/item-types/builtin/account.json`.
#[must_use]
pub fn legacy_extension(type_id: &str) -> Option<String> {
    let extension = match type_id {
        "account" => ".account",
        "login" => ".login",
        "passkey" => ".passkey",
        "card" => ".card",
        "secret" => ".secret",
        "drop" => ".drop",
        "note" => ".note",
        "certificate" => ".cert",
        _ => return None,
    };
    Some(extension.to_owned())
}

fn extension(type_id: &str, extension_of: ExtensionOf<'_>) -> String {
    extension_of(type_id).unwrap_or_else(|| {
        let slug: String = type_id
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .collect();
        format!(".{slug}")
    })
}

/// `pathSegment`: JS-trimmed, `Untitled` when empty, `/` made fullwidth.
#[must_use]
pub fn path_segment(name: &str) -> String {
    let trimmed = name.trim_matches(is_js_space);
    let base = if trimmed.is_empty() {
        "Untitled"
    } else {
        trimmed
    };
    base.replace('/', "\u{ff0f}")
}

/// Two folders may share a display name; their paths must not.
fn distinct_folder_names(folders: &[FolderMeta]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    folders
        .iter()
        .map(|folder| {
            let base = path_segment(&folder.name);
            let nth = seen.entry(base.clone()).or_insert(0);
            *nth += 1;
            if *nth > 1 {
                format!("{base} ({nth})")
            } else {
                base
            }
        })
        .collect()
}

fn item_path(item: &ItemMeta, prefix: &str, extension_of: ExtensionOf<'_>) -> String {
    format!(
        "{prefix}{}{}",
        path_segment(&item.name),
        extension(item.type_id(), extension_of)
    )
}

/// Every item's path, in `buildRows` order: each folder's items, then the
/// items at the root (including those whose folder no longer exists).
fn item_paths(body: &OpenedBody, extension_of: ExtensionOf<'_>) -> HashMap<String, String> {
    let names = distinct_folder_names(&body.folders);
    let in_folder = |item: &ItemMeta| {
        item.folder_id
            .as_deref()
            .and_then(|id| body.folders.iter().position(|folder| folder.id == id))
    };
    let mut paths = HashMap::new();
    for (index, name) in names.iter().enumerate() {
        let prefix = format!("{name}/");
        for item in body
            .items
            .iter()
            .filter(|item| in_folder(item) == Some(index))
        {
            paths.insert(item.id.clone(), item_path(item, &prefix, extension_of));
        }
    }
    for item in body.items.iter().filter(|item| in_folder(item).is_none()) {
        paths.insert(item.id.clone(), item_path(item, "", extension_of));
    }
    paths
}

/// Names, kinds and paths — never a field value.
#[must_use]
pub fn summarize(
    file: &SealedVaultFile,
    body: &OpenedBody,
    extension_of: ExtensionOf<'_>,
) -> OpenedVaultFile {
    let paths = item_paths(body, extension_of);
    let header_rev = file.header.body_rev();
    OpenedVaultFile {
        format: file.format,
        tomb: file.tomb.clone(),
        bound: body.bound,
        rev: body.rev,
        header_rev,
        rolled_back: body.rev.unwrap_or(0) < header_rev.unwrap_or(0),
        folders: body.folders.len(),
        items: body
            .items
            .iter()
            .map(|item| VaultFileEntry {
                id: item.id.clone(),
                name: item.name.clone(),
                kind: item.kind.clone(),
                path: paths
                    .get(&item.id)
                    .cloned()
                    .unwrap_or_else(|| item.name.clone()),
            })
            .collect(),
        concealed: if body.carries_device_identity_key {
            vec![DEVICE_IDENTITY_KEY_PATH.to_owned()]
        } else {
            Vec::new()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{legacy_extension, path_segment};

    #[test]
    fn segments_match_the_tree() {
        assert_eq!(path_segment("  a/b \u{feff}"), "a\u{ff0f}b");
        assert_eq!(path_segment(" \t"), "Untitled");
        assert_eq!(path_segment("\u{85}x"), "\u{85}x");
        assert_eq!(legacy_extension("certificate").as_deref(), Some(".cert"));
        assert_eq!(legacy_extension("wifi"), None);
    }

    #[test]
    fn login_is_listed_beside_account() {
        assert_eq!(legacy_extension("account").as_deref(), Some(".account"));
        assert_eq!(legacy_extension("login").as_deref(), Some(".login"));
        // The `account` row is the item type definition's own extension.
        let definition: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../marketplace/item-types/builtin/account.json"
        ))
        .expect("the account definition parses");
        assert_eq!(definition["spec"]["extension"], ".account");
        assert_eq!(definition["metadata"]["id"], "account");
    }
}
