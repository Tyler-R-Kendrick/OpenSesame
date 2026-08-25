//! In-memory, TTL-bound session state.
//!
//! **Nothing here is ever written to disk.** There is deliberately no
//! `Serialize`, no `save`, no cache path, and no `Debug` that can print a
//! token or a key. A session lives for the one CLI invocation that unlocked
//! it and dies with the process; `bw`'s `BW_SESSION` model — a long-lived
//! unlocked key handed around in an environment variable — is exactly what
//! this replaces.

use std::fmt;
use std::time::{Duration, SystemTime};

use secrecy::{ExposeSecret, SecretString};

use crate::api::TokenResponse;
use crate::crypto::SymmetricKey;
use crate::error::{Error, Result};

/// How long an unlocked session may live regardless of token lifetime.
pub const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
/// Refresh this long before the access token actually expires.
const REFRESH_SKEW: Duration = Duration::from_secs(60);

/// Tokens plus the decrypted user key. Held only in memory.
pub struct Session {
    access_token: SecretString,
    refresh_token: Option<SecretString>,
    user_key: SymmetricKey,
    token_expires_at: SystemTime,
    expires_at: SystemTime,
}

impl Session {
    /// Build from a token response and the already-unwrapped user key.
    pub fn new(
        token: &TokenResponse,
        user_key: SymmetricKey,
        ttl: Duration,
        now: SystemTime,
    ) -> Self {
        let lifetime = Duration::from_secs(token.expires_in.unwrap_or(3600));
        Self {
            access_token: SecretString::from(token.access_token.clone()),
            refresh_token: token.refresh_token.clone().map(SecretString::from),
            user_key,
            token_expires_at: now + lifetime,
            expires_at: now + ttl,
        }
    }

    /// The session TTL, not the token lifetime: the hard wall.
    #[must_use]
    pub fn is_expired_at(&self, now: SystemTime) -> bool {
        now >= self.expires_at
    }

    #[must_use]
    pub fn is_expired(&self) -> bool {
        self.is_expired_at(SystemTime::now())
    }

    /// True when the access token is close enough to expiry to warrant a
    /// `refresh_token` grant.
    #[must_use]
    pub fn needs_refresh_at(&self, now: SystemTime) -> bool {
        now + REFRESH_SKEW >= self.token_expires_at
    }

    /// The bearer token, or a named error once the TTL has passed. Callers
    /// cannot reach the token through any other path.
    ///
    /// # Errors
    ///
    /// Returns [`Error::SessionExpired`] once the hard session TTL has passed.
    pub fn access_token_at(&self, now: SystemTime) -> Result<&str> {
        if self.is_expired_at(now) {
            return Err(Error::SessionExpired);
        }
        Ok(self.access_token.expose_secret())
    }

    /// Return the current bearer token while the session remains valid.
    ///
    /// # Errors
    ///
    /// Returns [`Error::SessionExpired`] once the hard session TTL has passed.
    pub fn access_token(&self) -> Result<&str> {
        self.access_token_at(SystemTime::now())
    }

    pub fn refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_ref().map(ExposeSecret::expose_secret)
    }

    /// The user key, gated on the same TTL as the token: an expired session
    /// yields no decryption capability either.
    ///
    /// # Errors
    ///
    /// Returns [`Error::SessionExpired`] once the hard session TTL has passed.
    pub fn user_key_at(&self, now: SystemTime) -> Result<&SymmetricKey> {
        if self.is_expired_at(now) {
            return Err(Error::SessionExpired);
        }
        Ok(&self.user_key)
    }

    /// Return the decrypted user key while the session remains valid.
    ///
    /// # Errors
    ///
    /// Returns [`Error::SessionExpired`] once the hard session TTL has passed.
    pub fn user_key(&self) -> Result<&SymmetricKey> {
        self.user_key_at(SystemTime::now())
    }

    /// Adopt a refreshed token. The user key is unchanged — a refresh grant
    /// never re-derives key material — and the session TTL does **not**
    /// restart, so refreshing cannot extend an unlock indefinitely.
    pub fn adopt(&mut self, token: &TokenResponse, now: SystemTime) {
        self.access_token = SecretString::from(token.access_token.clone());
        if let Some(refresh) = token.refresh_token.clone() {
            self.refresh_token = Some(SecretString::from(refresh));
        }
        self.token_expires_at = now + Duration::from_secs(token.expires_in.unwrap_or(3600));
    }

    /// Drop key material and tokens now rather than at scope exit.
    pub fn expire_now(&mut self) {
        self.expires_at = SystemTime::UNIX_EPOCH;
        self.token_expires_at = SystemTime::UNIX_EPOCH;
    }
}

/// Redacted by construction: no token, no key, not even a length.
impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("user_key", &"<redacted>")
            .field("token_expires_at", &self.token_expires_at)
            .field("expires_at", &self.expires_at)
            .field("expired", &self.is_expired())
            .finish()
    }
}
