//! Response bodies. Bitwarden's own servers answer in `camelCase`; older
//! vaultwarden in `PascalCase`; both are accepted.

use serde::Deserialize;

/// `POST /identity/accounts/prelogin` — the KDF parameters for an account.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreloginResponse {
    #[serde(alias = "Kdf")]
    pub kdf: u32,
    #[serde(alias = "KdfIterations")]
    pub kdf_iterations: u32,
    #[serde(default, alias = "KdfMemory")]
    pub kdf_memory: Option<u32>,
    #[serde(default, alias = "KdfParallelism")]
    pub kdf_parallelism: Option<u32>,
}

/// `POST /identity/connect/token` — OAuth fields are `snake_case`, Bitwarden's
/// own additions are `PascalCase`. Both shapes are accepted.
#[derive(Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default, alias = "Key")]
    pub key: Option<String>,
    #[serde(default, alias = "PrivateKey")]
    pub private_key: Option<String>,
}

impl std::fmt::Debug for TokenResponse {
    /// Every field here is a credential or key material; only the lifetime prints.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("access_token", &"[REDACTED]")
            .field("expires_in", &self.expires_in)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    #[serde(default, alias = "Profile")]
    pub profile: Option<ProfileResponse>,
    #[serde(default, alias = "Folders")]
    pub folders: Vec<FolderResponse>,
    #[serde(default, alias = "Ciphers")]
    pub ciphers: Vec<CipherResponse>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    #[serde(default, alias = "Id")]
    pub id: Option<String>,
    #[serde(default, alias = "Email")]
    pub email: Option<String>,
    #[serde(default, alias = "Key")]
    pub key: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResponse {
    #[serde(default, alias = "Id")]
    pub id: Option<String>,
    #[serde(default, alias = "Name")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CipherResponse {
    #[serde(default, alias = "Id")]
    pub id: Option<String>,
    #[serde(default, alias = "OrganizationId")]
    pub organization_id: Option<String>,
    #[serde(default, alias = "FolderId")]
    pub folder_id: Option<String>,
    #[serde(default, rename = "type", alias = "Type")]
    pub cipher_type: Option<u8>,
    #[serde(default, alias = "Name")]
    pub name: Option<String>,
    #[serde(default, alias = "Notes")]
    pub notes: Option<String>,
    #[serde(default, alias = "Favorite")]
    pub favorite: Option<bool>,
    #[serde(default, alias = "DeletedDate")]
    pub deleted_date: Option<String>,
    #[serde(default, alias = "Login")]
    pub login: Option<LoginResponse>,
    #[serde(default, alias = "Fields")]
    pub fields: Option<Vec<FieldResponse>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    #[serde(default, alias = "Username")]
    pub username: Option<String>,
    #[serde(default, alias = "Password")]
    pub password: Option<String>,
    #[serde(default, alias = "Totp")]
    pub totp: Option<String>,
    #[serde(default, alias = "Uris")]
    pub uris: Option<Vec<UriResponse>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UriResponse {
    #[serde(default, alias = "Uri")]
    pub uri: Option<String>,
    // The wire field is `match` (camelCase servers) or `Match` (PascalCase
    // servers) — never `uriMatch`, which is what `rename_all` would have
    // produced from the Rust field name.
    #[serde(default, rename = "match", alias = "Match")]
    pub uri_match: Option<u8>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldResponse {
    #[serde(default, alias = "Name")]
    pub name: Option<String>,
    #[serde(default, alias = "Value")]
    pub value: Option<String>,
    #[serde(default, rename = "type", alias = "Type")]
    pub field_type: Option<u8>,
}

impl std::fmt::Debug for LoginResponse {
    /// The password and the TOTP seed are credentials; the username and the
    /// URIs are what identify the login.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginResponse")
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("totp", &self.totp.as_ref().map(|_| "[REDACTED]"))
            .field("uris", &self.uris)
            .finish()
    }
}

impl std::fmt::Debug for FieldResponse {
    /// A custom field may be hidden (a secret); its value never prints.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FieldResponse")
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "[REDACTED]"))
            .field("field_type", &self.field_type)
            .finish()
    }
}

/// `GET /api/config` — server version and feature flags. Read to record what
/// the peer is; never to gate on a value the server chose.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResponse {
    #[serde(default, alias = "Version")]
    pub version: Option<String>,
    #[serde(default, alias = "GitHash")]
    pub git_hash: Option<String>,
}

#[cfg(test)]
mod debug_redaction {
    use super::*;

    #[test]
    fn a_token_response_prints_no_credential() {
        let response: TokenResponse = serde_json::from_str(
            r#"{"access_token":"at-12345","refresh_token":"rt-12345","Key":"2.key","PrivateKey":"2.pk","expires_in":3600}"#,
        )
        .unwrap();
        let shown = format!("{response:?}");
        for leaked in ["at-12345", "rt-12345", "2.key", "2.pk"] {
            assert!(!shown.contains(leaked), "{leaked} in {shown}");
        }
        assert!(shown.contains("3600"));
    }

    #[test]
    fn a_login_and_its_fields_print_no_credential() {
        let login: LoginResponse = serde_json::from_str(
            r#"{"username":"alice","password":"pw-12345","totp":"otpseed-12345"}"#,
        )
        .unwrap();
        let shown = format!("{login:?}");
        assert!(
            shown.contains("[REDACTED]") && shown.contains("alice"),
            "{shown}"
        );
        for leaked in ["pw-12345", "otpseed-12345"] {
            assert!(!shown.contains(leaked), "{leaked} in {shown}");
        }
        let field: FieldResponse =
            serde_json::from_str(r#"{"name":"pin","value":"fieldval-12345","type":1}"#).unwrap();
        let shown = format!("{field:?}");
        assert!(
            shown.contains("pin") && shown.contains("[REDACTED]"),
            "{shown}"
        );
        assert!(!shown.contains("fieldval-12345"), "{shown}");
    }
}
