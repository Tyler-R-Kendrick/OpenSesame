//! PBKDF2-HMAC-SHA256, accepted for verification only.
//!
//! This is the shape a Bitwarden or vaultwarden server has stored for years.
//! Keeping it verifiable lets an account imported from one sign in once, at
//! which point the registry replaces the hash with the current scheme's. It
//! can never write a new hash.

use argon2::password_hash::{PasswordHash, PasswordVerifier as _};

use super::{HashError, PasswordHashScheme};

/// Verify-only `$pbkdf2-sha256$i=…,l=…$salt$hash`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pbkdf2Sha256Legacy;

impl PasswordHashScheme for Pbkdf2Sha256Legacy {
    fn id(&self) -> &'static str {
        "pbkdf2-sha256"
    }

    fn hash(&self, _secret: &[u8]) -> Result<String, HashError> {
        Err(HashError(
            "pbkdf2-sha256 is accepted for verification only".into(),
        ))
    }

    fn verify(&self, stored: &PasswordHash<'_>, secret: &[u8]) -> bool {
        pbkdf2::Pbkdf2.verify_password(secret, stored).is_ok()
    }

    fn is_current(&self, _stored: &PasswordHash<'_>) -> bool {
        false
    }

    fn can_write(&self) -> bool {
        false
    }
}
