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
#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldResponse {
    #[serde(default, alias = "Name")]
    pub name: Option<String>,
    #[serde(default, alias = "Value")]
    pub value: Option<String>,
    #[serde(default, rename = "type", alias = "Type")]
    pub field_type: Option<u8>,
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
