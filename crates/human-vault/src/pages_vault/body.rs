//! The sealed body (vault-format-v1 §6): opened under VK bound to its tomb
//! with AAD `"vault-seal" NUL <tomb> NUL "body"`, falling back once to the
//! legacy unbound seal and saying so. Only what may be shown is kept — each
//! item's id, name, kind and folder, each folder's id and name, and the
//! revision; field values are skipped by the parser and the decrypted bytes
//! are zeroized. The device identity key the body may carry (ADR 0160 §5) is
//! reduced to the fact that it is there: its value is never read out.

use serde::{de::IgnoredAny, Deserialize};
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
    /// A credential's account (ADR 0178); `null` for one kept on its own.
    #[serde(rename = "accountId", default)]
    pub(super) account_id: Option<String>,
    /// A credential's method, reduced to its type: never a value.
    #[serde(default)]
    pub(super) method: Option<MethodMeta>,
}

/// A credential's method as listed: the type and nothing else.
#[derive(Deserialize)]
pub(super) struct MethodMeta {
    #[serde(rename = "type", default)]
    pub(super) kind: Option<String>,
}

impl ItemMeta {
    /// `itemTypeId`: a plugin-defined item's `typeId`, a credential's type
    /// (`credentialTypeId`), else its kind.
    pub(super) fn type_id(&self) -> &str {
        match (&*self.kind, &self.type_id) {
            ("typed", Some(type_id)) => type_id,
            ("credential", _) => credential_type_id(self.method.as_ref()),
            _ => &self.kind,
        }
    }
}

/// `credentialTypeId`: the item type a login method type is kept as. A method
/// this reader does not know is listed as the bare kind, as a typed item of an
/// unknown type is.
fn credential_type_id(method: Option<&MethodMeta>) -> &'static str {
    match method.and_then(|method| method.kind.as_deref()) {
        Some("password") => "password",
        Some("api-key") => "api-key",
        Some("token") => "token",
        Some("oauth") => "oauth-client",
        Some("authenticator") => "authenticator",
        _ => "credential",
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
    /// Whether the field is present, and nothing of it: `IgnoredAny` skips the
    /// value as the parser reads it, so the private half is never built into
    /// a string or a tree. `null` is absent, as in the TypeScript reader.
    #[serde(rename = "deviceIdentityKey", default)]
    device_identity_key: Option<IgnoredAny>,
}

/// A body opened with VK, reduced to what may be shown.
pub struct OpenedBody {
    pub(super) items: Vec<ItemMeta>,
    pub(super) folders: Vec<FolderMeta>,
    /// The sealed `rev`, when the body carries one.
    pub rev: Option<u64>,
    /// The body carries a device identity key (ADR 0160 §5). Its value is not
    /// held here, so nothing downstream can print it.
    pub carries_device_identity_key: bool,
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
    read_body(&plain, bound)
}

/// The plaintext body, reduced to what may be shown.
fn read_body(plain: &[u8], bound: bool) -> Result<OpenedBody> {
    let wire: BodyWire = serde_json::from_slice(plain)
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
        carries_device_identity_key: wire.device_identity_key.is_some(),
        bound,
    })
}

#[cfg(test)]
mod tests {
    use super::{read_body, vault_seal_binding};
    use serde_json::Value;

    #[test]
    fn binding_is_the_writers_bytes() {
        assert_eq!(
            vault_seal_binding("personal", "body"),
            b"vault-seal\0personal\0body"
        );
    }

    /// The cases `spec/conformance/vault-vectors.json` records for which body
    /// shapes list the device identity key; the TypeScript reader runs the
    /// same rows (`vault-file.test.ts`).
    #[test]
    fn lists_the_key_for_the_bodies_the_fixture_names() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../spec/conformance/vault-vectors.json"
        ))
        .expect("fixture");
        let rows = fixture["concealedBodies"].as_array().expect("rows");
        assert!(rows.len() >= 5);
        for row in rows {
            let opened = read_body(row["body"].to_string().as_bytes(), true).expect("body");
            let expected = row["concealed"].as_array().expect("expectation").len() == 1;
            assert_eq!(
                opened.carries_device_identity_key, expected,
                "{}",
                row["name"]
            );
        }
    }
}
