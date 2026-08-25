//! The decrypted vault model.
//!
//! Everything here is already plaintext, so it exists only on the human
//! plane: `apps/cli` builds it under a TTY ceremony and drops it when the
//! process exits. No agent surface (`ConnectionRef`, MCP tool, WIT import) can
//! reach it — constitution C1.
//!
//! Per-item decryption failures do **not** poison the whole sync. An item
//! whose fields this client cannot open (a COSE/type-7 cipher, say) is
//! recorded in [`Vault::unreadable`] with its named reason; asking for that
//! item by name or id returns that named error rather than silence.

use serde::Serialize;
use zeroize::Zeroizing;

use crate::api::{CipherResponse, SyncResponse};
use crate::crypto::{EncString, SymmetricKey};
use crate::error::{Error, Result};

/// Bitwarden cipher types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Login,
    SecureNote,
    Card,
    Identity,
    Other(u8),
}

impl ItemKind {
    fn from_wire(value: Option<u8>) -> Self {
        match value {
            Some(1) => ItemKind::Login,
            Some(2) => ItemKind::SecureNote,
            Some(3) => ItemKind::Card,
            Some(4) => ItemKind::Identity,
            Some(other) => ItemKind::Other(other),
            None => ItemKind::Other(0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Uri {
    pub uri: String,
    /// Bitwarden's URI match type (0 domain … 5 never); `None` = default.
    pub match_type: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CustomField {
    pub name: String,
    pub value: Option<String>,
    /// 0 text, 1 hidden, 2 boolean, 3 linked.
    pub field_type: Option<u8>,
}

/// A login's decrypted fields. `Debug` redacts the password and TOTP seed so
/// an accidental `{:?}` in a log line cannot leak them; `Serialize` does not,
/// because serializing the vault is the explicit human-plane export path.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Login {
    pub username: Option<String>,
    pub password: Option<String>,
    pub totp: Option<String>,
    pub uris: Vec<Uri>,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Login")
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("totp", &self.totp.as_ref().map(|_| "<redacted>"))
            .field("uris", &self.uris)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub organization_id: Option<String>,
    pub favorite: bool,
    pub kind: ItemKind,
    pub notes: Option<String>,
    pub fields: Vec<CustomField>,
    pub login: Option<Login>,
}

impl Item {
    /// `Folder/Name` when foldered, otherwise just `Name`.
    #[must_use]
    pub fn path(&self) -> String {
        match self.folder.as_deref() {
            Some(folder) if !folder.is_empty() => format!("{folder}/{}", self.name),
            _ => self.name.clone(),
        }
    }
}

/// An item this client could not open, and why. Named, never silent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UnreadableItem {
    pub id: String,
    /// Present when the *name* decrypted but something else did not.
    pub name: Option<String>,
    pub code: &'static str,
    pub reason: String,
}

/// A secret-free listing row. This is what `List` returns — names and
/// locations, never a password.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ItemSummary {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub kind: ItemKind,
    pub username: Option<String>,
    pub uris: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Vault {
    pub folders: Vec<Folder>,
    pub items: Vec<Item>,
    /// Items in the trash, and organization items whose collection key this
    /// personal-vault client never unwraps. Counted, not guessed at.
    pub skipped_deleted: usize,
    pub skipped_organization: usize,
    pub unreadable: Vec<UnreadableItem>,
}

impl Vault {
    /// Decrypt a `/api/sync` payload with the account's user key.
    ///
    /// # Errors
    ///
    /// Returns a named decryption or response error only when vault-level
    /// processing cannot continue. Per-item failures are retained in
    /// [`Self::unreadable`].
    pub fn from_sync(sync: &SyncResponse, key: &SymmetricKey) -> Result<Self> {
        let mut vault = Vault::default();
        for folder in &sync.folders {
            let Some(id) = folder.id.clone() else {
                continue;
            };
            let name = match decrypt_opt(key, folder.name.as_deref()) {
                Ok(name) => name.unwrap_or_default(),
                Err(error) => {
                    vault.unreadable.push(UnreadableItem {
                        id: id.clone(),
                        name: None,
                        code: error.code(),
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            vault.folders.push(Folder { id, name });
        }
        vault.folders.sort_by(|a, b| a.name.cmp(&b.name));

        for cipher in &sync.ciphers {
            if cipher.deleted_date.is_some() {
                vault.skipped_deleted += 1;
                continue;
            }
            if cipher.organization_id.is_some() {
                // Organization ciphers are wrapped with a collection key that
                // arrives through the org key RSA path (EncString types 3-6),
                // which this client deliberately does not implement.
                vault.skipped_organization += 1;
                continue;
            }
            let id = cipher.id.clone().unwrap_or_default();
            match decrypt_cipher(cipher, key, &vault.folders) {
                Ok(item) => vault.items.push(item),
                Err((name, error)) => vault.unreadable.push(UnreadableItem {
                    id,
                    name,
                    code: error.code(),
                    reason: error.to_string(),
                }),
            }
        }
        vault
            .items
            .sort_by(|a, b| a.path().cmp(&b.path()).then(a.id.cmp(&b.id)));
        vault.unreadable.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(vault)
    }

    /// Resolve a resource: exact id, then `Folder/Name`, then bare name
    /// (case-insensitive). An ambiguous name is an error, never a guess.
    ///
    /// # Errors
    ///
    /// Returns a named unreadable-item error, [`Error::ItemNotFound`], or
    /// [`Error::AmbiguousItem`] when the resource cannot be resolved exactly.
    pub fn find(&self, resource: &str) -> Result<&Item> {
        let needle = resource.trim();
        if let Some(item) = self.items.iter().find(|item| item.id == needle) {
            return Ok(item);
        }
        if let Some(unreadable) = self.unreadable.iter().find(|u| u.id == needle) {
            return Err(unreadable_error(unreadable));
        }
        let by_path: Vec<&Item> = self
            .items
            .iter()
            .filter(|item| item.path().eq_ignore_ascii_case(needle))
            .collect();
        match by_path.as_slice() {
            [only] => return Ok(only),
            [] => {}
            many => {
                return Err(Error::AmbiguousItem {
                    resource: needle.to_owned(),
                    count: many.len(),
                })
            }
        }
        let by_name: Vec<&Item> = self
            .items
            .iter()
            .filter(|item| item.name.eq_ignore_ascii_case(needle))
            .collect();
        match by_name.as_slice() {
            [only] => Ok(only),
            [] => {
                if let Some(unreadable) = self.unreadable.iter().find(|u| {
                    u.name
                        .as_deref()
                        .is_some_and(|n| n.eq_ignore_ascii_case(needle))
                }) {
                    return Err(unreadable_error(unreadable));
                }
                Err(Error::ItemNotFound(needle.to_owned()))
            }
            many => Err(Error::AmbiguousItem {
                resource: needle.to_owned(),
                count: many.len(),
            }),
        }
    }

    /// The login password for a resource — the native equivalent of
    /// `bw get password <id> --raw`.
    ///
    /// # Errors
    ///
    /// Returns the errors from [`Self::find`] or [`Error::NoPassword`] when
    /// the matched item has no login password.
    pub fn password(&self, resource: &str) -> Result<Zeroizing<String>> {
        let item = self.find(resource)?;
        item.login
            .as_ref()
            .and_then(|login| login.password.clone())
            .map(Zeroizing::new)
            .ok_or_else(|| Error::NoPassword(item.path()))
    }

    /// Secret-free listing rows, sorted by path.
    #[must_use]
    pub fn summaries(&self) -> Vec<ItemSummary> {
        self.items
            .iter()
            .map(|item| ItemSummary {
                id: item.id.clone(),
                name: item.name.clone(),
                folder: item.folder.clone(),
                kind: item.kind,
                username: item.login.as_ref().and_then(|login| login.username.clone()),
                uris: item
                    .login
                    .as_ref()
                    .map(|login| login.uris.iter().map(|u| u.uri.clone()).collect())
                    .unwrap_or_default(),
            })
            .collect()
    }
}

fn unreadable_error(unreadable: &UnreadableItem) -> Error {
    match unreadable.code {
        "cose_encrypt_unsupported" => Error::CoseEncryptUnsupported,
        _ => Error::MalformedResponse {
            path: "/api/sync".into(),
            message: unreadable.reason.clone(),
        },
    }
}

fn decrypt_cipher(
    cipher: &CipherResponse,
    key: &SymmetricKey,
    folders: &[Folder],
) -> std::result::Result<Item, (Option<String>, Error)> {
    let name = decrypt_opt(key, cipher.name.as_deref())
        .map_err(|error| (None, error))?
        .unwrap_or_default();
    let decrypt = |raw: Option<&str>| decrypt_opt(key, raw).map_err(|e| (Some(name.clone()), e));
    let notes = decrypt(cipher.notes.as_deref())?;
    let login = match cipher.login.as_ref() {
        Some(login) => {
            let mut uris = Vec::new();
            for uri in login.uris.iter().flatten() {
                if let Some(value) = decrypt(uri.uri.as_deref())? {
                    uris.push(Uri {
                        uri: value,
                        match_type: uri.uri_match,
                    });
                }
            }
            Some(Login {
                username: decrypt(login.username.as_deref())?,
                password: decrypt(login.password.as_deref())?,
                totp: decrypt(login.totp.as_deref())?,
                uris,
            })
        }
        None => None,
    };
    let mut fields = Vec::new();
    for field in cipher.fields.iter().flatten() {
        fields.push(CustomField {
            name: decrypt(field.name.as_deref())?.unwrap_or_default(),
            value: decrypt(field.value.as_deref())?,
            field_type: field.field_type,
        });
    }
    let folder = cipher.folder_id.as_ref().and_then(|id| {
        folders
            .iter()
            .find(|folder| &folder.id == id)
            .map(|folder| folder.name.clone())
    });
    Ok(Item {
        id: cipher.id.clone().unwrap_or_default(),
        name,
        folder,
        organization_id: cipher.organization_id.clone(),
        favorite: cipher.favorite.unwrap_or(false),
        kind: ItemKind::from_wire(cipher.cipher_type),
        notes,
        fields,
        login,
    })
}

fn decrypt_opt(key: &SymmetricKey, raw: Option<&str>) -> Result<Option<String>> {
    match EncString::parse_optional(raw)? {
        Some(enc) => Ok(Some(key.decrypt_string(&enc)?.to_string())),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(id: &str, folder: Option<&str>, name: &str, password: Option<&str>) -> Item {
        Item {
            id: id.into(),
            name: name.into(),
            folder: folder.map(str::to_owned),
            organization_id: None,
            favorite: false,
            kind: ItemKind::Login,
            notes: None,
            fields: vec![],
            login: Some(Login {
                username: Some("user".into()),
                password: password.map(str::to_owned),
                totp: None,
                uris: vec![],
            }),
        }
    }

    fn vault() -> Vault {
        Vault {
            folders: vec![Folder {
                id: "f1".into(),
                name: "Work".into(),
            }],
            items: vec![
                login("a", Some("Work"), "GitHub", Some("gh")),
                login("b", Some("Personal"), "GitHub", Some("gh-personal")),
                login("c", None, "Router", Some("r")),
            ],
            skipped_deleted: 0,
            skipped_organization: 0,
            unreadable: vec![],
        }
    }

    #[test]
    fn item_paths_include_the_folder_when_there_is_one() {
        assert_eq!(vault().items[0].path(), "Work/GitHub");
        assert_eq!(vault().items[2].path(), "Router");
        let mut item = login("d", Some(""), "Empty", None);
        item.folder = Some(String::new());
        assert_eq!(item.path(), "Empty");
    }

    #[test]
    fn an_id_wins_over_every_name() {
        assert_eq!(vault().find("a").unwrap().path(), "Work/GitHub");
    }

    #[test]
    fn a_folder_path_disambiguates_a_duplicated_name() {
        let vault = vault();
        assert_eq!(&*vault.password("Work/GitHub").unwrap(), "gh");
        assert_eq!(&*vault.password("personal/github").unwrap(), "gh-personal");
    }

    #[test]
    fn a_duplicated_bare_name_is_ambiguous_never_a_guess() {
        let error = vault().find("GitHub").unwrap_err();
        assert_eq!(error.code(), "ambiguous_item");
        assert!(matches!(error, Error::AmbiguousItem { count: 2, .. }));
    }

    #[test]
    fn a_unique_bare_name_resolves_case_insensitively() {
        assert_eq!(&*vault().password("rOuTeR").unwrap(), "r");
        assert_eq!(&*vault().password("  Router  ").unwrap(), "r");
    }

    #[test]
    fn an_item_without_a_password_is_distinguished_from_a_missing_one() {
        let mut vault = vault();
        vault.items.push(login("d", None, "Empty", None));
        vault.items.push(Item {
            login: None,
            ..login("e", None, "Note", None)
        });
        assert_eq!(vault.password("Empty").unwrap_err().code(), "no_password");
        assert_eq!(vault.password("Note").unwrap_err().code(), "no_password");
        assert_eq!(
            vault.password("Absent").unwrap_err().code(),
            "item_not_found"
        );
    }

    #[test]
    fn an_unreadable_item_reports_its_own_named_reason() {
        let mut vault = vault();
        vault.unreadable.push(UnreadableItem {
            id: "z".into(),
            name: Some("COSE item".into()),
            code: "cose_encrypt_unsupported",
            reason: "…".into(),
        });
        assert_eq!(
            vault.find("z").unwrap_err().code(),
            "cose_encrypt_unsupported"
        );
        assert_eq!(
            vault.find("cose item").unwrap_err().code(),
            "cose_encrypt_unsupported"
        );
    }

    #[test]
    fn summaries_never_carry_a_password_or_a_note() {
        let mut vault = vault();
        vault.items[0].notes = Some("nuclear codes".into());
        vault.items[0].fields.push(CustomField {
            name: "pin".into(),
            value: Some("4815".into()),
            field_type: Some(1),
        });
        let rendered = serde_json::to_string(&vault.summaries()).unwrap();
        assert!(!rendered.contains("gh-personal"), "{rendered}");
        assert!(!rendered.contains("nuclear codes"), "{rendered}");
        assert!(!rendered.contains("4815"), "{rendered}");
        assert!(rendered.contains("GitHub"), "{rendered}");
    }

    #[test]
    fn login_debug_redacts_the_password_and_totp_seed() {
        let item = Item {
            login: Some(Login {
                username: Some("octocat".into()),
                password: Some("s3cr3t".into()),
                totp: Some("JBSWY3DPEHPK3PXP".into()),
                uris: vec![],
            }),
            ..login("x", None, "GitHub", None)
        };
        let rendered = format!("{:?}", item.login.unwrap());
        assert!(rendered.contains("octocat"), "{rendered}");
        assert!(!rendered.contains("s3cr3t"), "{rendered}");
        assert!(!rendered.contains("JBSWY3DPEHPK3PXP"), "{rendered}");
    }

    #[test]
    fn cipher_types_map_to_named_kinds() {
        assert_eq!(ItemKind::from_wire(Some(1)), ItemKind::Login);
        assert_eq!(ItemKind::from_wire(Some(2)), ItemKind::SecureNote);
        assert_eq!(ItemKind::from_wire(Some(3)), ItemKind::Card);
        assert_eq!(ItemKind::from_wire(Some(4)), ItemKind::Identity);
        assert_eq!(ItemKind::from_wire(Some(9)), ItemKind::Other(9));
        assert_eq!(ItemKind::from_wire(None), ItemKind::Other(0));
    }
}
