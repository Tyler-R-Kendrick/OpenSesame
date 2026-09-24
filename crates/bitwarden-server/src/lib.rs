//! A Bitwarden-compatible server: point a Bitwarden client — `bw`, the
//! browser extension, the desktop and mobile apps — at the Host, and it signs
//! in, unlocks, syncs and edits its vault as it would against Bitwarden's own
//! server (ADR 0141).
//!
//! # Zero knowledge
//!
//! Every value a client encrypts arrives as an `EncString` and is stored and
//! returned verbatim. The server holds the client-wrapped user key, never the
//! user key; it receives the client's master-password *hash*, never the
//! password, and stores only a hash of that hash.
//!
//! # Two KDFs, both replaceable
//!
//! * The **client KDF** turns the master password into the master key. The
//!   client runs it; the server remembers the choice and polices its range
//!   ([`kdf`]). Argon2id at Bitwarden's recommended 64 MiB / 3 / 4 is what an
//!   unknown email is told at prelogin, and the operator may refuse PBKDF2.
//! * The **server hash** protects the stored credential ([`hashing`]).
//!   Argon2id writes it; a registry keyed by the PHC algorithm id verifies it,
//!   so a successor scheme can take over with every account migrating on its
//!   next sign-in.
//!
//! # Scope
//!
//! Personal vaults: accounts, devices, folders and ciphers of every type.
//! Organizations, collections, Sends, attachments, emergency access and
//! two-factor providers are not served; the routes that would carry them
//! answer as a server with the feature off.

pub mod auth;
pub mod error;
pub mod hashing;
pub mod kdf;
mod routes;
pub mod tokens;
mod wire;

use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use opensesame_storage::Db;
use tokio::sync::{OnceCell, Semaphore};
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};
use crate::hashing::{HashRegistry, Verdict};
use crate::kdf::KdfPolicy;
use crate::tokens::TokenKeys;

/// Who may create an account.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SignupPolicy {
    /// Nobody: the default. An operator opens signups to onboard people.
    #[default]
    Closed,
    /// Anyone who can reach the server.
    Open,
    /// Only addresses at these domains (lower-case, no `@`).
    Domains(Vec<String>),
}

impl SignupPolicy {
    /// Parse `closed`, `open`, or a comma-separated domain list.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "closed" | "off" | "false" => Self::Closed,
            "open" | "on" | "true" => Self::Open,
            list => Self::Domains(
                list.split(',')
                    .map(|d| d.trim().trim_start_matches('@').to_owned())
                    .filter(|d| !d.is_empty())
                    .collect(),
            ),
        }
    }

    #[must_use]
    pub fn allows(&self, email: &str) -> bool {
        match self {
            Self::Closed => false,
            Self::Open => true,
            Self::Domains(domains) => email
                .rsplit_once('@')
                .is_some_and(|(_, domain)| domains.iter().any(|d| d == domain)),
        }
    }
}

/// How the server behaves. Nothing here is secret.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// The URL a client is configured with, e.g. `https://host/bitwarden`.
    /// Reported back in `/api/config` and used as the token issuer.
    pub public_url: String,
    pub signups: SignupPolicy,
    pub kdf: KdfPolicy,
    pub access_token_ttl: Duration,
    /// Server-side hashes computed at once. Each Argon2id hash holds its
    /// memory cost for its duration, so this bounds the memory a burst of
    /// sign-in attempts can take.
    pub hash_concurrency: usize,
}

impl ServerConfig {
    #[must_use]
    pub fn new(public_url: &str) -> Self {
        Self {
            public_url: public_url.trim_end_matches('/').to_owned(),
            signups: SignupPolicy::Closed,
            kdf: KdfPolicy::default(),
            access_token_ttl: Duration::from_secs(3600),
            hash_concurrency: 4,
        }
    }
}

pub struct Inner {
    pub db: Db,
    pub config: ServerConfig,
    pub hashes: HashRegistry,
    pub tokens: TokenKeys,
    hash_permits: Semaphore,
    decoy_hash: OnceCell<String>,
}

/// The server state every route shares.
#[derive(Clone)]
pub struct BitwardenServer(Arc<Inner>);

impl Deref for BitwardenServer {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl BitwardenServer {
    /// A server over `db`. `token_secret` of `None` signs access tokens with
    /// a per-process random key.
    #[must_use]
    pub fn new(
        db: Db,
        config: ServerConfig,
        hashes: HashRegistry,
        token_secret: Option<&[u8]>,
    ) -> Self {
        let ttl = i64::try_from(config.access_token_ttl.as_secs()).unwrap_or(3600);
        let issuer = format!("{}/identity", config.public_url);
        let permits = config.hash_concurrency.max(1);
        Self(Arc::new(Inner {
            db,
            tokens: TokenKeys::new(token_secret, &issuer, ttl),
            config,
            hashes,
            hash_permits: Semaphore::new(permits),
            decoy_hash: OnceCell::new(),
        }))
    }

    /// Every Bitwarden route, relative to the configured server URL.
    pub fn router(self) -> Router {
        routes::router(self)
    }

    /// Hash a client's master-password hash under the current scheme.
    pub(crate) async fn hash_secret(&self, secret: &str) -> ApiResult<String> {
        let _permit = self
            .hash_permits
            .acquire()
            .await
            .map_err(|e| ApiError::internal(&e.into()))?;
        let hashes = self.hashes.clone();
        let secret = Zeroizing::new(secret.to_owned());
        tokio::task::spawn_blocking(move || hashes.hash(secret.as_bytes()))
            .await
            .map_err(|e| ApiError::internal(&e.into()))?
            .map_err(|e| ApiError::internal(&e.into()))
    }

    async fn verify_secret(&self, stored: String, secret: &str) -> ApiResult<Verdict> {
        let _permit = self
            .hash_permits
            .acquire()
            .await
            .map_err(|e| ApiError::internal(&e.into()))?;
        let hashes = self.hashes.clone();
        let secret = Zeroizing::new(secret.to_owned());
        tokio::task::spawn_blocking(move || hashes.verify(&stored, secret.as_bytes()))
            .await
            .map_err(|e| ApiError::internal(&e.into()))
    }

    /// Check a client's master-password hash for `user_id`'s stored hash,
    /// upgrading the stored hash when the registry asks for it. Returns
    /// whether it matched.
    pub(crate) async fn check_secret(
        &self,
        user_id: &str,
        stored: &str,
        secret: &str,
    ) -> ApiResult<bool> {
        match self.verify_secret(stored.to_owned(), secret).await? {
            Verdict::Mismatch => Ok(false),
            Verdict::Match { rehash } => {
                if let Some(rehash) = rehash {
                    self.db
                        .bitwarden_set_password_hash(user_id, &rehash)
                        .await?;
                }
                Ok(true)
            }
        }
    }

    /// Spend the same work on an unknown email as on a known one, so the
    /// answer's timing does not say which it was.
    pub(crate) async fn decoy_check(&self, secret: &str) -> ApiResult<()> {
        let decoy = self
            .decoy_hash
            .get_or_try_init(|| self.hash_secret("opensesame-decoy"))
            .await?
            .clone();
        let _ = self.verify_secret(decoy, secret).await?;
        Ok(())
    }
}
