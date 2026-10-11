//! Encryption of the master secret (SLIP-0039, "Encryption of the master
//! secret"): a four-round Feistel network whose round function is PBKDF2 with
//! HMAC-SHA256. It is a wide-block permutation, so a partial view of the shares
//! does not become a partial view of the secret.

use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::error::Slip39Error;
use crate::secret::Secret;

const ROUNDS: u8 = 4;
/// Iterations per round: 2500 << e, so 10 000 << e across the four rounds.
const ROUND_ITERATIONS: u32 = 2500;
const SALT_PREFIX: &[u8] = b"shamir";

/// The largest exponent the format can carry (4 bits).
pub const MAX_ITERATION_EXPONENT: u8 = 15;

/// What the cipher needs besides the secret. No `Debug`: it holds a passphrase.
#[derive(Clone, Copy)]
pub struct CipherParams<'a> {
    /// Printable ASCII; empty is what other tools assume.
    pub passphrase: &'a str,
    /// PBKDF2 runs 10 000 x 2^e times in all.
    pub iteration_exponent: u8,
    /// The 15-bit identifier of the backup.
    pub identifier: u16,
    /// Extendable backups use an empty salt.
    pub extendable: bool,
    /// Refuse a share that asks for more work than this.
    pub max_iteration_exponent: u8,
}

/// The passphrase's bytes, or a refusal if any is outside 32..=126.
///
/// # Errors
/// [`Slip39Error::Passphrase`].
pub fn check_passphrase(passphrase: &str) -> Result<&[u8], Slip39Error> {
    if passphrase.bytes().all(|b| (32..=126).contains(&b)) {
        Ok(passphrase.as_bytes())
    } else {
        Err(Slip39Error::Passphrase)
    }
}

fn salt_for(identifier: u16, extendable: bool) -> Vec<u8> {
    if extendable {
        return Vec::new();
    }
    let mut salt = SALT_PREFIX.to_vec();
    salt.extend_from_slice(&identifier.to_be_bytes());
    salt
}

fn round(
    index: u8,
    passphrase: &[u8],
    exponent: u8,
    salt: &[u8],
    right: &[u8],
) -> Zeroizing<Vec<u8>> {
    let mut password = Zeroizing::new(vec![index]);
    password.extend_from_slice(passphrase);
    let mut pbkdf_salt = Zeroizing::new(salt.to_vec());
    pbkdf_salt.extend_from_slice(right);
    let mut out = Zeroizing::new(vec![0_u8; right.len()]);
    pbkdf2_hmac::<Sha256>(
        &password,
        &pbkdf_salt,
        ROUND_ITERATIONS << exponent,
        &mut out,
    );
    out
}

fn feistel(
    input: &[u8],
    params: &CipherParams<'_>,
    order: impl Iterator<Item = u8>,
) -> Result<Secret, Slip39Error> {
    let limit = params.max_iteration_exponent.min(MAX_ITERATION_EXPONENT);
    if params.iteration_exponent > limit {
        return Err(Slip39Error::IterationExponent {
            got: params.iteration_exponent,
            limit,
        });
    }
    let passphrase = check_passphrase(params.passphrase)?;
    let salt = salt_for(params.identifier, params.extendable);
    let (left, right) = input.split_at(input.len() / 2);
    let (mut left, mut right) = (
        Zeroizing::new(left.to_vec()),
        Zeroizing::new(right.to_vec()),
    );
    for index in order {
        let f = round(index, passphrase, params.iteration_exponent, &salt, &right);
        let next: Zeroizing<Vec<u8>> =
            Zeroizing::new(left.iter().zip(f.iter()).map(|(l, f)| l ^ f).collect());
        left = std::mem::replace(&mut right, next);
    }
    let mut joined = Vec::with_capacity(input.len());
    joined.extend_from_slice(&right);
    joined.extend_from_slice(&left);
    Ok(Secret::new(joined))
}

/// Encrypt a master secret.
///
/// # Errors
/// [`Slip39Error`] for a passphrase outside printable ASCII or an exponent
/// above the limit.
pub fn encrypt(master_secret: &[u8], params: &CipherParams<'_>) -> Result<Secret, Slip39Error> {
    feistel(master_secret, params, 0..ROUNDS)
}

/// Decrypt the encrypted master secret.
///
/// # Errors
/// As [`encrypt`].
pub fn decrypt(encrypted: &[u8], params: &CipherParams<'_>) -> Result<Secret, Slip39Error> {
    feistel(encrypted, params, (0..ROUNDS).rev())
}

#[cfg(test)]
mod tests {
    use super::{decrypt, encrypt, CipherParams};

    fn params(passphrase: &str, extendable: bool) -> CipherParams<'_> {
        CipherParams {
            passphrase,
            iteration_exponent: 0,
            identifier: 0x1234,
            extendable,
            max_iteration_exponent: 15,
        }
    }

    #[test]
    fn decrypt_undoes_encrypt() {
        let master: Vec<u8> = (0..16).collect();
        for extendable in [false, true] {
            let p = params("", extendable);
            let sealed = encrypt(&master, &p).unwrap();
            assert_ne!(sealed.expose(), &master[..]);
            assert_eq!(decrypt(sealed.expose(), &p).unwrap().expose(), &master[..]);
        }
    }

    #[test]
    fn the_passphrase_and_the_salt_format_change_the_result() {
        let master = [7_u8; 16];
        let base = encrypt(&master, &params("", true)).unwrap();
        assert_ne!(
            base.expose(),
            encrypt(&master, &params("x", true)).unwrap().expose()
        );
        assert_ne!(
            base.expose(),
            encrypt(&master, &params("", false)).unwrap().expose()
        );
    }

    #[test]
    fn refuses_a_high_exponent_and_a_non_ascii_passphrase() {
        let mut p = params("", true);
        p.iteration_exponent = 7;
        p.max_iteration_exponent = 6;
        assert!(decrypt(&[0; 16], &p).is_err());
        assert!(encrypt(&[0; 16], &params("pässword", true)).is_err());
    }
}
