//! The sealed body (vault-format-v1 §6): opened under VK bound to its tomb
//! with AAD `"vault-seal" NUL <tomb> NUL "body"`, falling back once to the
//! legacy unbound seal and saying so. Only what may be shown is kept — each
//! item's id, name, kind and folder, each folder's id and name, and the
//! revision; field values are skipped by the parser and the decrypted bytes
//! are zeroized.

use serde::Deserialize;
use serde_json::Value;

use super::{
    envelope::SealedVaultFile,
    error::{Result, VaultFileError},
    header::js_integer,
    keys::{open_seal, VaultKey},
};

/// `vaultSealBinding(tomb, path)`: the additional data of a bound seal.
#[must_use]
pub fn vault_seal_binding(tomb: &str, path: &str) -> Vec<u8> {
    format!("vault-seal\0{tomb}\0{path}").into_bytes()
}

/// An item as listed: never a field value.
#[derive(Deserialize)]
pub(super) struct ItemMeta {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) kind: String,
    #[serde(rename = "typeId", default)]
    pub(super) type_id: Option<String>,
    #[serde(rename = "folderId", default)]
    pub(super) folder_id: Option<String>,
}

impl ItemMeta {
    /// `itemTypeId`: a plugin-defined item's `typeId`, else its kind.
    pub(super) fn type_id(&self) -> &str {
        match (&*self.kind, &self.type_id) {
            ("typed", Some(type_id)) => type_id,
            _ => &self.kind,
        }
    }
}

#[derive(Deserialize)]
pub(super) struct FolderMeta {
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Deserialize)]
struct BodyWire {
    items: Option<Vec<ItemMeta>>,
    folders: Option<Vec<FolderMeta>>,
    rev: Option<Value>,
}

/// A body opened with VK, reduced to what may be shown.
pub struct OpenedBody {
    pub(super) items: Vec<ItemMeta>,
    pub(super) folders: Vec<FolderMeta>,
    /// The sealed `rev`, when the body carries one.
    pub rev: Option<u64>,
    /// Sealed to its tomb; `false` is a legacy unbound body, which proves only
    /// that it was sealed under this VK, not which tomb it belongs to.
    pub bound: bool,
}

/// Open the body bound to the file's tomb, falling back to unbound (§6).
///
/// # Errors
///
/// `Corrupt` when neither seal opens or the plaintext is not a vault body.
pub fn open_body(file: &SealedVaultFile, key: &VaultKey) -> Result<OpenedBody> {
    let binding = vault_seal_binding(&file.tomb, "body");
    let (plain, bound) = match open_seal(key.bytes(), &file.body, &binding) {
        Some(plain) => (plain, true),
        None => (
            open_seal(key.bytes(), &file.body, &[])
                .ok_or(VaultFileError::Corrupt("authentication tag mismatch"))?,
            false,
        ),
    };
    let wire: BodyWire = serde_json::from_slice(&plain)
        .map_err(|_| VaultFileError::Corrupt("decrypted payload is not a vault body"))?;
    let rev = match wire.rev {
        None | Some(Value::Null) => None,
        Some(rev) => Some(
            js_integer(&rev).ok_or(VaultFileError::Corrupt("the body revision is malformed"))?,
        ),
    };
    Ok(OpenedBody {
        items: wire.items.unwrap_or_default(),
        folders: wire.folders.unwrap_or_default(),
        rev,
        bound,
    })
}

#[cfg(test)]
mod tests {
    use super::vault_seal_binding;

    #[test]
    fn binding_is_the_writers_bytes() {
        assert_eq!(
            vault_seal_binding("personal", "body"),
            b"vault-seal\0personal\0body"
        );
    }
}
