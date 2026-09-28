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

use url::Url;

use crate::error::{Error, Result};

mod classify;
mod endpoints;
mod wire;

use classify::classify_error;
use endpoints::host_of;
pub use endpoints::Endpoints;
pub use wire::{
    CipherResponse, ConfigResponse, FieldResponse, FolderResponse, LoginResponse, PreloginResponse,
    ProfileResponse, SyncResponse, TokenResponse, UriResponse,
};

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
        self.login_password_answering(email, password_hash_b64, &[])
            .await
    }

    /// Password grant with the answer to a challenge the first attempt
    /// raised: `twoFactorToken` and `twoFactorProvider` after
    /// [`Error::TwoFactorRequired`], `newdeviceotp` after
    /// [`Error::NewDeviceVerification`].
    ///
    /// # Errors
    ///
    /// As [`Client::login_password`].
    pub async fn login_password_answering(
        &self,
        email: &str,
        password_hash_b64: &str,
        answer: &[(&str, &str)],
    ) -> Result<TokenResponse> {
        let email = crate::crypto::normalize_email(email);
        let device_type = self.device.device_type.to_string();
        let mut form = vec![
            ("grant_type", "password"),
            ("username", email.as_str()),
            ("password", password_hash_b64),
            ("scope", SCOPE),
            ("client_id", CLIENT_ID),
            ("deviceType", device_type.as_str()),
            ("deviceIdentifier", self.device.identifier.as_str()),
            ("deviceName", self.device.name.as_str()),
        ];
        form.extend_from_slice(answer);
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

    /// `GET {api}{path}` as raw JSON, for a caller that keeps what the server
    /// sent rather than reading it (the importer copies ciphertext verbatim).
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, API, URL, or response-validation error.
    pub async fn get_json(&self, path: &str, access_token: &str) -> Result<serde_json::Value> {
        let url = self.endpoints.api_url(path)?;
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

    /// `POST {api}{path}` with a JSON body, answered as raw JSON. The importer
    /// uses it for the account's own sign-in settings (ADR 0148).
    ///
    /// # Errors
    ///
    /// Returns a transport, redirect, API, URL, or response-validation error.
    pub async fn post_json(
        &self,
        path: &str,
        access_token: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let url = self.endpoints.api_url(path)?;
        let response = self
            .http
            .post(url.clone())
            .bearer_auth(access_token)
            .header("accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        self.decode(&url, response).await
    }

    /// Fetch a file's ciphertext from a download link the server issued
    /// (an attachment's URL, which may sit on a storage host of its own). No
    /// credential goes with it: the link carries its own authorization.
    /// https only (loopback http for tests); redirects refused; at most
    /// `limit` bytes.
    ///
    /// # Errors
    ///
    /// Returns a URL, transport, redirect, API, or size error.
    pub async fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>> {
        let url = endpoints::parse_download(url)?;
        let response = self
            .http
            .get(url.clone())
            .send()
            .await
            .map_err(|e| transport(&url, &e))?;
        let status = response.status();
        if status.is_redirection() {
            return Err(Error::RedirectRefused {
                status: status.as_u16(),
                path: url.path().to_owned(),
            });
        }
        if !status.is_success() {
            return Err(Error::Api {
                path: url.path().to_owned(),
                status: status.as_u16(),
                message: "download refused".into(),
            });
        }
        let bytes = response.bytes().await.map_err(|e| transport(&url, &e))?;
        if bytes.len() > limit {
            return Err(Error::MalformedResponse {
                path: url.path().to_owned(),
                message: format!("download exceeded {limit} bytes"),
            });
        }
        Ok(bytes.to_vec())
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
