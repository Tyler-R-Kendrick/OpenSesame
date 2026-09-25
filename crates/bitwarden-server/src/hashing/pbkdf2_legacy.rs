//! PBKDF2-HMAC-SHA256, accepted for verification only.
//!
//! Neither Bitwarden's server nor vaultwarden stores PHC strings: vaultwarden
//! keeps raw hash, salt and iteration columns, and Bitwarden an ASP.NET
//! Identity blob. An importer would convert such a record into this PHC form
//! (`$pbkdf2-sha256$i=…,l=32$salt$hash`); none ships yet. The scheme is here
//! so that path needs no new code, and it is how the registry's migration is
//! exercised end to end: a hash it accepts verifies once, and the registry
//! replaces it with the current scheme's. It can never write a new hash.

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
