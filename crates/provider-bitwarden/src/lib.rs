//! Native Bitwarden / Vaultwarden **consume-client**.
//!
//! This crate replaces "shell out to the `bw` CLI" for the
//! `bitwarden` / `vaultwarden` providers: a user's real Bitwarden account or
//! self-hosted vaultwarden becomes an upstream credential source that
//! OpenSesame reads directly, with no Node runtime, no `BW_SESSION`
//! environment variable, and no unlocked key living outside the process that
//! asked for it.
//!
//! # Plane
//!
//! Human plane only (constitution C1/C2). The master password is prompted on
//! a TTY by `apps/cli`, held in a [`secrecy::SecretString`], zeroized on
//! drop, and never written to disk, never placed in argv, never placed in an
//! environment variable. The unlocked session ([`session::Session`]) is
//! in-memory and TTL-bound. Nothing in this crate is reachable from an agent
//! surface: no MCP tool, no WIT import, no ConnectionRef invoke path.
//!
//! # Egress
//!
//! The server URL is user-configured, so it cannot appear in the static
//! `EGRESS_RULES` table. Instead this crate mirrors `crates/invoke-through`'s
//! discipline in-crate: the configured host is pinned, https is required
//! (loopback http only so offline tests can run), and **redirects are refused
//! rather than followed** — a 3xx is a response, never a chase.
//!
//! # Daemon budget
//!
//! `apps/daemon` does not depend on this crate and must not (constitution
//! C4). `scripts/daemon-deps-gate.sh` is the alarm if that ever changes.
//!
//! # Attribution
//!
//! The Bitwarden protocol and crypto construction are implemented from the
//! public format description. The design is informed by **rbw**
//! (MIT, <https://github.com/doy/rbw>) — see this crate's `NOTICE`. No source
//! is copied from AGPL/GPL projects (vaultwarden, Bitwarden clients/server).
//!
//! # Example
//!
//! ```no_run
//! # async fn run() -> Result<(), opensesame_provider_bitwarden::Error> {
//! use opensesame_provider_bitwarden::{BitwardenClient, Config};
//! use secrecy::SecretString;
//!
//! let config = Config::from_server_url("https://vault.example.com")?;
//! let mut client =
//!     BitwardenClient::unlock(config, "user@example.com", &SecretString::from("…")).await?;
//! let password = client.read("Work/GitHub").await?;
//! # let _ = password;
//! # Ok(())
//! # }
//! ```

pub mod api;
pub mod crypto;
pub mod error;
pub mod session;
pub mod vault;

use std::time::{Duration, SystemTime};

use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

pub use api::{Client, ConfigResponse, DeviceIdentity, Endpoints, SyncResponse};
pub use crypto::{
    normalize_email, EncString, EncType, Kdf, MasterKey, SymmetricKey, DEFAULT_PBKDF2_ITERATIONS,
    MIN_PBKDF2_ITERATIONS,
};
pub use error::{Error, Result};
pub use session::{Session, DEFAULT_SESSION_TTL};
pub use vault::{CustomField, Folder, Item, ItemKind, ItemSummary, Login, UnreadableItem, Uri, Vault};

/// Everything needed to reach a server, and nothing secret.
#[derive(Clone, Debug)]
pub struct Config {
    pub endpoints: Endpoints,
    pub device: DeviceIdentity,
    pub session_ttl: Duration,
}

impl Config {
    /// One configured server URL — cloud or self-hosted, resolved by
    /// [`Endpoints::from_server_url`].
    pub fn from_server_url(server_url: &str) -> Result<Self> {
        Ok(Self {
            endpoints: Endpoints::from_server_url(server_url)?,
            device: DeviceIdentity::default(),
            session_ttl: DEFAULT_SESSION_TTL,
        })
    }

    /// Explicit split bases, for `api.bitwarden.com`-style deployments that a
    /// single URL cannot describe.
    pub fn from_split_urls(api_url: &str, identity_url: &str) -> Result<Self> {
        Ok(Self {
            endpoints: Endpoints::split(api_url, identity_url)?,
            device: DeviceIdentity::default(),
            session_ttl: DEFAULT_SESSION_TTL,
        })
    }

    #[must_use]
    pub fn with_device(mut self, device: DeviceIdentity) -> Self {
        self.device = device;
        self
    }

    #[must_use]
    pub fn with_session_ttl(mut self, ttl: Duration) -> Self {
        self.session_ttl = ttl;
        self
    }
}

/// An unlocked, in-memory Bitwarden session plus the HTTP client that fed it.
#[derive(Debug)]
pub struct BitwardenClient {
    api: Client,
    session: Session,
    /// A sync fetched during unlock (because the token response carried no
    /// user key) is reused rather than re-fetched.
    pending_sync: Option<SyncResponse>,
}

impl BitwardenClient {
    /// prelogin → derive → password grant → unwrap the user key.
    ///
    /// The server only ever sees the master password *hash* (PBKDF2 over the
    /// master key, salted with the password itself), never the password and
    /// never anything that decrypts the vault.
    pub async fn unlock(
        config: Config,
        email: &str,
        master_password: &SecretString,
    ) -> Result<Self> {
        let ttl = config.session_ttl;
        let api = Client::new(config.endpoints, config.device)?;
        let prelogin = api.prelogin(email).await?;
        let kdf = Kdf::from_prelogin(
            prelogin.kdf,
            prelogin.kdf_iterations,
            prelogin.kdf_memory,
            prelogin.kdf_parallelism,
        )?;
        let password = Zeroizing::new(master_password.expose_secret().as_bytes().to_vec());
        let master_key = MasterKey::derive(&password, email, &kdf)?;
        let hash = Zeroizing::new(master_key.password_hash_b64(&password));
        let token = api.login_password(email, &hash).await?;

        let mut pending_sync = None;
        let wrapped = match token.key.as_deref() {
            Some(key) if !key.trim().is_empty() => key.to_owned(),
            _ => {
                // Some servers omit `Key` on the token and only expose it on
                // the profile; fetch once and keep the payload.
                let sync = api.sync(&token.access_token).await?;
                let key = sync
                    .profile
                    .as_ref()
                    .and_then(|profile| profile.key.clone())
                    .ok_or_else(|| Error::MalformedResponse {
                        path: "/sync".into(),
                        message: "neither the token nor the profile carried a user key".into(),
                    })?;
                pending_sync = Some(sync);
                key
            }
        };
        let user_key = master_key.decrypt_user_key(&wrapped.parse::<EncString>()?)?;
        let session = Session::new(&token, user_key, ttl, SystemTime::now());
        Ok(Self {
            api,
            session,
            pending_sync,
        })
    }

    /// The in-memory session. There is no way to persist it.
    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn api(&self) -> &Client {
        &self.api
    }

    /// Sync and decrypt the personal vault.
    pub async fn vault(&mut self) -> Result<Vault> {
        let sync = match self.pending_sync.take() {
            Some(sync) => sync,
            None => {
                self.refresh_if_needed().await?;
                let token = self.session.access_token()?.to_owned();
                self.api.sync(&token).await?
            }
        };
        Vault::from_sync(&sync, self.session.user_key()?)
    }

    /// `bw get password <resource> --raw`, natively.
    pub async fn read(&mut self, resource: &str) -> Result<Zeroizing<String>> {
        self.vault().await?.password(resource)
    }

    /// `bw list items --raw`, natively — and secret-free: names, folders,
    /// usernames and URIs only, never a password.
    pub async fn list(&mut self) -> Result<String> {
        let vault = self.vault().await?;
        serde_json::to_string_pretty(&vault.summaries()).map_err(|e| Error::MalformedResponse {
            path: "/sync".into(),
            message: e.to_string(),
        })
    }

    /// Server version/flags, for diagnostics.
    pub async fn server_config(&self) -> Result<ConfigResponse> {
        self.api.config().await
    }

    async fn refresh_if_needed(&mut self) -> Result<()> {
        let now = SystemTime::now();
        if self.session.is_expired_at(now) {
            return Err(Error::SessionExpired);
        }
        if !self.session.needs_refresh_at(now) {
            return Ok(());
        }
        let Some(refresh_token) = self.session.refresh_token().map(str::to_owned) else {
            return Ok(());
        };
        let token = self.api.refresh(&refresh_token).await?;
        self.session.adopt(&token, now);
        Ok(())
    }
}
