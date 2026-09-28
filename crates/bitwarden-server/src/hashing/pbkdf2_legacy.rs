//! PBKDF2-HMAC-SHA256, accepted for verification only.
//!
//! Neither Bitwarden's server nor vaultwarden stores PHC strings: vaultwarden
//! keeps raw hash, salt and iteration columns, and Bitwarden an ASP.NET
//! Identity blob. The importer (ADR 0148) writes vaultwarden's columns in the
//! PHC form `$pbkdf2-sha256$i=…,l=32$salt$hash` ([`pbkdf2_sha256_record`]); a
//! hash in that form verifies once, and the registry replaces it with the
//! current scheme's. This scheme can never write a new hash.
//!
//! vaultwarden's salts are 64 bytes, 86 characters of base64 — longer than
//! the 64 characters generic PHC parsers accept — so a string they refuse is
//! read here instead ([`PasswordHashScheme::verify_unparsed`]).

use argon2::password_hash::{PasswordHash, PasswordVerifier as _};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use sha2::Sha256;
use subtle::ConstantTimeEq as _;

use super::{HashError, PasswordHashScheme};

const ID: &str = "pbkdf2-sha256";
/// Bounds on what a stored record may ask of a sign-in. vaultwarden's own
/// default is 600 000; older servers used 100 000.
const MAX_ITERATIONS: u32 = 10_000_000;
const OUTPUT: std::ops::RangeInclusive<usize> = 16..=64;

/// Verify-only `$pbkdf2-sha256$i=…,l=…$salt$hash`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pbkdf2Sha256Legacy;

/// A PBKDF2-SHA256 hash as a stored record, in PHC form with standard base64.
#[must_use]
pub fn pbkdf2_sha256_record(iterations: u32, salt: &[u8], hash: &[u8]) -> String {
    format!(
        "${ID}$i={iterations},l={}${}${}",
        hash.len(),
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(hash)
    )
}

/// `(iterations, salt, hash)` from a record, whatever its salt length.
fn parse(stored: &str) -> Option<(u32, Vec<u8>, Vec<u8>)> {
    let mut parts = stored.strip_prefix('$')?.split('$');
    if parts.next()? != ID {
        return None;
    }
    let (mut iterations, mut length) = (None, None);
    for param in parts.next()?.split(',') {
        match param.split_once('=')? {
            ("i", value) => iterations = value.parse::<u32>().ok(),
            ("l", value) => length = value.parse::<usize>().ok(),
            _ => return None,
        }
    }
    let salt = STANDARD_NO_PAD.decode(parts.next()?).ok()?;
    let hash = STANDARD_NO_PAD.decode(parts.next()?).ok()?;
    let iterations = iterations.filter(|i| (1..=MAX_ITERATIONS).contains(i))?;
    if parts.next().is_some()
        || salt.is_empty()
        || !OUTPUT.contains(&hash.len())
        || length.is_some_and(|l| l != hash.len())
    {
        return None;
    }
    Some((iterations, salt, hash))
}

impl PasswordHashScheme for Pbkdf2Sha256Legacy {
    fn id(&self) -> &'static str {
        ID
    }

    fn hash(&self, _secret: &[u8]) -> Result<String, HashError> {
        Err(HashError(
            "pbkdf2-sha256 is accepted for verification only".into(),
        ))
    }

    fn verify(&self, stored: &PasswordHash<'_>, secret: &[u8]) -> bool {
        pbkdf2::Pbkdf2.verify_password(secret, stored).is_ok()
    }

    fn verify_unparsed(&self, stored: &str, secret: &[u8]) -> bool {
        let Some((iterations, salt, hash)) = parse(stored) else {
            return false;
        };
        let mut derived = vec![0_u8; hash.len()];
        pbkdf2::pbkdf2_hmac::<Sha256>(secret, &salt, iterations, &mut derived);
        derived.ct_eq(&hash).into()
    }

    fn is_current(&self, _stored: &PasswordHash<'_>) -> bool {
        false
    }

    fn can_write(&self) -> bool {
        false
    }
}
