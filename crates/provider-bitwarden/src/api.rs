//! Bitwarden / Vaultwarden HTTP surface.
//!
//! Four endpoints are enough to read a personal vault:
//! `POST {identity}/accounts/prelogin`, `POST {identity}/connect/token`
//! (password and `refresh_token` grants), `GET {api}/sync`, `GET {api}/config`.
//!
//! Two topologies must both work:
//! * **bitwarden.com / bitwarden.eu** — *separate* hosts,
//!   `https://api.bitwarden.com` and `https://identity.bitwarden.com`;
//! * **vaultwarden** (and self-hosted Bitwarden) — one origin, with the two
//!   services mounted at `/api` and `/identity`.
//!
//! Egress discipline mirrors `crates/invoke-through`: the configured host is
//! pinned, https is required (loopback http is allowed so offline tests can
//! run), and **a 3xx is a response, never a chase** — redirects are refused
//! with a named error so a credential can never be ridden onto another host.

use std::time::Duration;

use serde::Deserialize;
use url::Url;

use crate::error::{Error, Result};

/// Body cap. A personal vault sync is orders of magnitude smaller.
const MAX_BODY: usize = 16 * 1024 * 1024;
const USER_AGENT: &str = "opensesame-cli";
/// Bitwarden's OAuth client id for CLI-shaped clients.
const CLIENT_ID: &str = "cli";
const SCOPE: &str = "api offline_access";

/// Device metadata Bitwarden's identity endpoint requires on the password
/// grant. Nothing here is a secret; it is how the server labels the session
/// in the account's device list.
#[derive(Clone, Debug)]
pub struct DeviceIdentity {
    pub identifier: String,
    pub name: String,
    pub device_type: u16,
}

impl DeviceIdentity {
    /// A stable, non-identifying default. Callers that want the server's
    /// device list to distinguish machines pass their own identifier.
    pub fn new(identifier: impl Into<String>) -> Self {
        Self {
            identifier: identifier.into(),
            name: "opensesame".to_owned(),
            device_type: default_device_type(),
        }
    }
}

impl Default for DeviceIdentity {
    fn default() -> Self {
        Self::new("opensesame-cli")
    }
}

const fn default_device_type() -> u16 {
    // Bitwarden's DeviceType enum: 6 WindowsDesktop, 7 MacOsDesktop,
    // 8 LinuxDesktop. Anything else the server treats as "unknown".
    if cfg!(target_os = "windows") {
        6
    } else if cfg!(target_os = "macos") {
        7
    } else {
        8
    }
}

/// The two service bases, already validated and pinned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    api: Url,
    identity: Url,
}

impl Endpoints {
    /// Derive both bases from one configured server URL.
    ///
    /// `https://vault.bitwarden.com` (or `.eu`, or a bare `bitwarden.com`)
    /// expands to the cloud's split hosts; everything else is treated as a
    /// self-hosted/vaultwarden origin with `/api` and `/identity` mounted
    /// under it, which is exactly what vaultwarden serves.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidServerUrl`] when the URL is malformed, lacks a
    /// usable host, or uses a forbidden scheme.
    pub fn from_server_url(raw: &str) -> Result<Self> {
        let base = parse_base(raw)?;
        if let Some(suffix) = cloud_suffix(&base) {
            return Self::split(
                &format!("https://api.{suffix}"),
                &format!("https://identity.{suffix}"),
            );
        }
        let trimmed = base.as_str().trim_end_matches('/').to_owned();
        Self::split(&format!("{trimmed}/api"), &format!("{trimmed}/identity"))
    }

    /// Explicit split bases, for a deployment that mounts them elsewhere.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidServerUrl`] when either URL is malformed,
    /// lacks a usable host, or uses a forbidden scheme.
    pub fn split(api: &str, identity: &str) -> Result<Self> {
        Ok(Self {
            api: parse_base(api)?,
            identity: parse_base(identity)?,
        })
    }

    #[must_use]
    pub fn api_base(&self) -> &Url {
        &self.api
    }

    #[must_use]
    pub fn identity_base(&self) -> &Url {
        &self.identity
    }

    /// The hosts this client is pinned to. Any other host is out of bounds.
    #[must_use]
    pub fn pinned_hosts(&self) -> Vec<String> {
        let mut hosts = vec![host_of(&self.api), host_of(&self.identity)];
        hosts.dedup();
        hosts
    }

    fn api_url(&self, path: &str) -> Result<Url> {
        join(&self.api, path)
    }

    fn identity_url(&self, path: &str) -> Result<Url> {
        join(&self.identity, path)
    }
}

fn cloud_suffix(base: &Url) -> Option<&'static str> {
    let host = base.host_str()?.to_ascii_lowercase();
    match host.as_str() {
        "bitwarden.com" | "vault.bitwarden.com" => Some("bitwarden.com"),
        "bitwarden.eu" | "vault.bitwarden.eu" => Some("bitwarden.eu"),
        _ => None,
    }
}

fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

/// https, or loopback http so offline tests can run against a stub. No
/// embedded credentials, ever — same rule as `provider-openbao`.
fn parse_base(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|e| Error::InvalidServerUrl(e.to_string()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::InvalidServerUrl(
            "server URL must not embed credentials".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(Error::InvalidServerUrl("server URL has no host".into()));
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(Error::InvalidServerUrl(
            "server URL must be https (loopback http is allowed for tests)".into(),
        )),
    }
}

fn join(base: &Url, path: &str) -> Result<Url> {
    let joined = format!("{}{}", base.as_str().trim_end_matches('/'), path);
    Url::parse(&joined).map_err(|e| Error::InvalidServerUrl(e.to_string()))
}

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

/// The HTTP client. Holds no key material — the session does.
#[derive(Debug)]
pub struct Client {
    http: reqwest::Client,
    endpoints: Endpoints,
    device: DeviceIdentity,
}

impl Client {
    /// Create a redirect-refusing HTTP client pinned to the supplied endpoints.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Transport`] when the underlying HTTP client cannot be
    /// constructed.
    pub fn new(endpoints: Endpoints, device: DeviceIdentity) -> Result<Self> {
        let http = reqwest::Client::builder()
            // A 3xx is a response, never a chase.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| Error::Transport {
                host: String::new(),
                message: e.to_string(),
            })?;
        Ok(Self {
            http,
            endpoints,
            device,
        })
    }

    #[must_use]
    pub fn endpoints(&self) -> &Endpoints {
        &self.endpoints
    }

    /// Fetch the account's key-derivation parameters.
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, API, URL, or response-validation error.
    pub async fn prelogin(&self, email: &str) -> Result<PreloginResponse> {
        let url = self.endpoints.identity_url("/accounts/prelogin")?;
        let response = self
            .http
            .post(url.clone())
            .json(&serde_json::json!({ "email": crate::crypto::normalize_email(email) }))
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        self.decode(&url, response).await
    }

    /// Password grant. `password_hash_b64` is the *master password hash* —
    /// PBKDF2 over the master key — not the password and not the key.
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, authentication, API, URL, or
    /// response-validation error.
    pub async fn login_password(
        &self,
        email: &str,
        password_hash_b64: &str,
    ) -> Result<TokenResponse> {
        let email = crate::crypto::normalize_email(email);
        let device_type = self.device.device_type.to_string();
        let form = [
            ("grant_type", "password"),
            ("username", email.as_str()),
            ("password", password_hash_b64),
            ("scope", SCOPE),
            ("client_id", CLIENT_ID),
            ("deviceType", device_type.as_str()),
            ("deviceIdentifier", self.device.identifier.as_str()),
            ("deviceName", self.device.name.as_str()),
        ];
        self.token_request(&form).await
    }

    /// Refresh grant. Bitwarden access tokens are short-lived; the refresh
    /// token stays in memory with the session and never reaches disk.
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, authentication, API, URL, or
    /// response-validation error.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResponse> {
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
        ];
        self.token_request(&form).await
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse> {
        let url = self.endpoints.identity_url("/connect/token")?;
        let response = self
            .http
            .post(url.clone())
            .header("device-type", self.device.device_type.to_string())
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        self.decode(&url, response).await
    }

    /// Full vault sync. `excludeDomains` keeps the payload to vault data.
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, API, URL, or response-validation error.
    pub async fn sync(&self, access_token: &str) -> Result<SyncResponse> {
        let url = self.endpoints.api_url("/sync?excludeDomains=true")?;
        let response = self
            .http
            .get(url.clone())
            .bearer_auth(access_token)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        self.decode(&url, response).await
    }

    /// Fetch nonsecret server version and feature information.
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, API, URL, or response-validation error.
    pub async fn config(&self) -> Result<ConfigResponse> {
        let url = self.endpoints.api_url("/config")?;
        let response = self
            .http
            .get(url.clone())
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        self.decode(&url, response).await
    }

    async fn decode<T: serde::de::DeserializeOwned>(
        &self,
        url: &Url,
        response: reqwest::Response,
    ) -> Result<T> {
        let status = response.status();
        let path = url.path().to_owned();
        if status.is_redirection() {
            return Err(Error::RedirectRefused {
                status: status.as_u16(),
                path,
            });
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| transport(url, &e))?
            .to_vec();
        if body.len() > MAX_BODY {
            return Err(Error::MalformedResponse {
                path,
                message: format!("response body exceeded {MAX_BODY} bytes"),
            });
        }
        if !status.is_success() {
            return Err(classify_error(&path, status.as_u16(), &body));
        }
        serde_json::from_slice(&body).map_err(|e| Error::MalformedResponse {
            path,
            message: e.to_string(),
        })
    }
}

fn transport(url: &Url, error: &reqwest::Error) -> Error {
    Error::Transport {
        host: host_of(url),
        message: error.to_string(),
    }
}

/// Turn a non-2xx body into a *named* error. Bitwarden signals a wrong master
/// password as `invalid_grant`, and a 2FA challenge as a 400 carrying
/// `TwoFactorProviders`; both deserve their own variant, not "HTTP 400".
fn classify_error(path: &str, status: u16, body: &[u8]) -> Error {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let field = |value: &serde_json::Value, key: &str| -> Option<String> {
        let upper = uppercase_first(key);
        value
            .get(key)
            .or_else(|| value.get(&upper))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    };
    if let Some(value) = parsed.as_ref() {
        let two_factor =
            value.get("TwoFactorProviders").is_some() || value.get("twoFactorProviders").is_some();
        if two_factor {
            return Error::TwoFactorRequired;
        }
        let code = field(value, "error");
        let description = field(value, "error_description")
            .or_else(|| field(value, "message"))
            .or_else(|| {
                value
                    .get("ErrorModel")
                    .or_else(|| value.get("errorModel"))
                    .and_then(|m| m.get("Message").or_else(|| m.get("message")))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            });
        if code.as_deref() == Some("invalid_grant") || status == 401 {
            return Error::Authentication(
                description.unwrap_or_else(|| "invalid username or master password".into()),
            );
        }
        if let Some(message) = description.or(code) {
            return Error::Api {
                path: path.to_owned(),
                status,
                message,
            };
        }
    }
    Error::Api {
        path: path.to_owned(),
        status,
        message: "no error detail in response".into(),
    }
}

fn uppercase_first(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}
