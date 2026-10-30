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
//! Personal vaults: accounts, devices, folders and ciphers of every type,
//! attachments and Sends; API-key sign-in and authenticator two-step login
//! ([`second_factor`]). Organizations, collections and emergency access are
//! not served; the routes that would carry them answer as a server with the
//! feature off.

pub mod auth;
mod budget_subject;
pub mod error;
pub mod hashing;
mod hashing_work;
pub mod import;
pub mod kdf;
mod limiter;
pub mod notifications;
pub(crate) mod routes;
pub mod second_factor;
pub mod tokens;
mod wire;

use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use crate::hashing::HashRegistry;
use crate::kdf::KdfPolicy;
use crate::tokens::TokenKeys;
use axum::Router;
use opensesame_storage::Db;
use tokio::sync::{OnceCell, Semaphore};

/// Who may create an account.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SignupPolicy {
    /// Nobody: the default. An operator opens signups to onboard people.
    #[default]
    Closed,
    /// Anyone who can reach the server.
    Open,
    /// Only addresses at these domains (lower-case, no `@`). This server
    /// sends no mail, so the list limits which addresses may be claimed; it
    /// does not prove the person claiming one receives its mail. Open it only
    /// on a network where that is acceptable, or while onboarding.
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
    /// Requests allowed to wait for a hash slot. Beyond it a request is
    /// refused at once (429) rather than queued without limit.
    pub hash_queue: usize,
    /// Checks an existing account may reserve per `failure_window` before
    /// actual verification is refused. Exhausted public requests do decoy work;
    /// a completed successful proof clears the account's budget.
    pub max_failed_sign_ins: u32,
    pub failure_window: Duration,
    /// A refresh token lapses after this long unused; each use slides it.
    pub refresh_token_ttl: Duration,
    /// The largest file (attachment or Send) one upload may carry.
    pub max_file_bytes: usize,
    /// The bytes of files one account may keep, attachments and Sends together.
    pub storage_quota_bytes: i64,
    /// A directory holding a build of Bitwarden's web vault to serve beside
    /// the API; `None` serves none.
    pub web_vault: Option<std::path::PathBuf>,
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
            hash_queue: 64,
            max_failed_sign_ins: 10,
            failure_window: Duration::from_secs(15 * 60),
            refresh_token_ttl: Duration::from_secs(30 * 24 * 3600),
            max_file_bytes: 100 * 1024 * 1024,
            storage_quota_bytes: 1024 * 1024 * 1024,
            web_vault: None,
        }
    }
}

pub struct Inner {
    pub db: Db,
    pub config: ServerConfig,
    pub hashes: HashRegistry,
    pub tokens: TokenKeys,
    /// Clients holding the live-sync hub open.
    pub hub: notifications::Hub,
    pub(crate) sign_in_failures: limiter::FailureLimiter,
    /// Sign-in requests made per address (ADR 0148 §8), apart from failures.
    pub(crate) sign_in_requests: limiter::FailureLimiter,
    hash_admission: Arc<Semaphore>,
    hash_permits: Arc<Semaphore>,
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
            db: db.clone(),
            tokens: TokenKeys::new(token_secret, &issuer, ttl),
            hub: notifications::Hub::default(),
            sign_in_failures: limiter::FailureLimiter::new(
                db.clone(),
                "verification",
                config.max_failed_sign_ins.max(1),
                config.failure_window,
            ),
            sign_in_requests: limiter::FailureLimiter::new(
                db,
                "sign-in-request",
                u32::try_from(routes::SIGN_IN_REQUESTS_PER_WINDOW).unwrap_or(5),
                routes::sign_in_request_window(),
            ),
            hash_admission: Arc::new(Semaphore::new(permits + config.hash_queue)),
            hash_permits: Arc::new(Semaphore::new(permits)),
            decoy_hash: OnceCell::new(),
            config,
            hashes,
        }))
    }

    /// Every Bitwarden route, relative to the configured server URL.
    pub fn router(self) -> Router {
        routes::router(self)
    }

    /// The routes mounted under `prefix` (e.g. `/bitwarden`). The bare
    /// `prefix/` — where a browser opens the web vault — is answered too,
    /// which a plain nest does not do.
    pub fn mounted(self, prefix: &str) -> Router {
        let router = self.router();
        if prefix.is_empty() {
            return router;
        }
        Router::new()
            .route(
                &format!("{prefix}/"),
                axum::routing::any_service(router.clone()),
            )
            .nest(prefix, router)
    }
}
