//! Server-side password hashing, algorithm-agile by construction.
//!
//! A Bitwarden client never sends its master password. It sends a *master
//! password hash* — its own KDF output run once more through PBKDF2 — and that
//! value is what the server must not store in the clear: it is a login
//! credential. So the server hashes it again before it touches the database.
//!
//! Every stored hash is a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`),
//! which names its own algorithm and parameters. That is what makes the
//! algorithm replaceable: the [`HashRegistry`] holds one *current* scheme that
//! every new hash is written with, and any number of *accepted* schemes that
//! may still verify an old one. A successful sign-in against an accepted
//! scheme, or against the current scheme under older parameters, is re-hashed
//! under the current one on the spot ([`Verdict::Match::rehash`]). Retiring
//! Argon2id for whatever succeeds it is therefore: implement
//! [`PasswordHashScheme`] for the successor, make it current, and keep Argon2id
//! accepted until the population has signed in once.

mod argon2id;
mod pbkdf2_legacy;

use std::sync::Arc;

pub use argon2::password_hash::PasswordHash;
pub use argon2id::Argon2idScheme;
pub use pbkdf2_legacy::Pbkdf2Sha256Legacy;

/// Why a hash could not be produced. Verification never errors: a stored hash
/// that cannot be read simply does not match.
#[derive(Debug, thiserror::Error)]
#[error("password hashing failed: {0}")]
pub struct HashError(pub String);

/// One password-hashing algorithm under one parameter set.
pub trait PasswordHashScheme: Send + Sync {
    /// The PHC algorithm identifier this scheme reads and writes, e.g. `argon2id`.
    fn id(&self) -> &'static str;

    /// Hash `secret` under a fresh random salt into a PHC string.
    ///
    /// # Errors
    ///
    /// Returns [`HashError`] when the scheme cannot produce a hash.
    fn hash(&self, secret: &[u8]) -> Result<String, HashError>;

    /// Constant-time check of `secret` against a parsed PHC hash of this
    /// scheme's algorithm.
    fn verify(&self, stored: &PasswordHash<'_>, secret: &[u8]) -> bool;

    /// Whether `stored` was written with exactly this scheme's parameters. A
    /// hash that verifies but is not current is re-hashed.
    fn is_current(&self, stored: &PasswordHash<'_>) -> bool;

    /// Whether this scheme may write new hashes. A verify-only legacy scheme
    /// answers `false` and can never be made current.
    fn can_write(&self) -> bool {
        true
    }
}

/// The outcome of checking a secret against a stored hash.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Wrong secret, unknown algorithm, or an unreadable stored value.
    Mismatch,
    /// The secret matches. `rehash` carries a replacement hash under the
    /// current scheme when the stored one is not current.
    Match { rehash: Option<String> },
}

/// The current scheme plus the schemes still accepted for verification.
#[derive(Clone)]
pub struct HashRegistry {
    current: Arc<dyn PasswordHashScheme>,
    accepted: Vec<Arc<dyn PasswordHashScheme>>,
}

impl HashRegistry {
    /// A registry that writes with `current`.
    ///
    /// # Panics
    ///
    /// Panics when `current` is a verify-only scheme: a registry must be able
    /// to write the hashes it asks for.
    #[must_use]
    pub fn new(current: Arc<dyn PasswordHashScheme>) -> Self {
        assert!(
            current.can_write(),
            "the current scheme must be able to write hashes"
        );
        Self {
            current,
            accepted: Vec::new(),
        }
    }

    /// Also verify hashes written by `scheme`, re-hashing them on success.
    #[must_use]
    pub fn accept(mut self, scheme: Arc<dyn PasswordHashScheme>) -> Self {
        self.accepted.push(scheme);
        self
    }

    /// The identifier of the scheme new hashes are written with.
    #[must_use]
    pub fn current_id(&self) -> &'static str {
        self.current.id()
    }

    /// Hash under the current scheme.
    ///
    /// # Errors
    ///
    /// Returns [`HashError`] when the current scheme cannot produce a hash.
    pub fn hash(&self, secret: &[u8]) -> Result<String, HashError> {
        self.current.hash(secret)
    }

    /// Verify `secret` against `stored`, choosing the scheme the PHC string
    /// names. An algorithm the registry does not know never matches.
    #[must_use]
    pub fn verify(&self, stored: &str, secret: &[u8]) -> Verdict {
        let Ok(parsed) = PasswordHash::new(stored) else {
            return Verdict::Mismatch;
        };
        let algorithm = parsed.algorithm.as_str();
        let current_matches = self.current.id() == algorithm;
        let scheme = if current_matches {
            Some(&self.current)
        } else {
            self.accepted.iter().find(|s| s.id() == algorithm)
        };
        let Some(scheme) = scheme else {
            return Verdict::Mismatch;
        };
        if !scheme.verify(&parsed, secret) {
            return Verdict::Mismatch;
        }
        if current_matches && self.current.is_current(&parsed) {
            return Verdict::Match { rehash: None };
        }
        // A failed re-hash must not fail a correct sign-in: the old hash
        // stays, and the next sign-in tries again.
        Verdict::Match {
            rehash: self.current.hash(secret).ok(),
        }
    }
}

impl Default for HashRegistry {
    /// Argon2id at OWASP's server-side parameters, accepting PBKDF2-SHA256
    /// hashes in PHC form verify-only, so a hash an importer converts into
    /// that form upgrades on its first sign-in (see [`Pbkdf2Sha256Legacy`]).
    fn default() -> Self {
        Self::new(Arc::new(Argon2idScheme::default())).accept(Arc::new(Pbkdf2Sha256Legacy))
    }
}

impl std::fmt::Debug for HashRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HashRegistry")
            .field("current", &self.current.id())
            .field(
                "accepted",
                &self.accepted.iter().map(|s| s.id()).collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests;
