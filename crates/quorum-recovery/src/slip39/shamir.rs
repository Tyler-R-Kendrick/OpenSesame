//! Shamir's secret sharing as SLIP-0039 specifies it: the secret lives at
//! f(255) and a digest of it at f(254), so a wrong set of shares is caught
//! (the digest check) rather than silently producing a wrong secret.
//!
//! Threshold 1 is not shared at all: every share is the secret.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::error::Slip39Error;
use super::gf256::{interpolate, Point};
use crate::secret::Secret;

/// Where the secret lives on the polynomial.
const SECRET_INDEX: u8 = 255;
/// Where its digest lives.
const DIGEST_INDEX: u8 = 254;
/// Digest length in bytes.
const DIGEST_LENGTH: usize = 4;

fn digest_of(random_part: &[u8], secret: &[u8]) -> Result<[u8; DIGEST_LENGTH], Slip39Error> {
    let mut mac = Hmac::<Sha256>::new_from_slice(random_part)
        .map_err(|_| Slip39Error::Parameters("the digest key has no usable length"))?;
    mac.update(secret);
    let full = mac.finalize().into_bytes();
    let mut out = [0_u8; DIGEST_LENGTH];
    out.copy_from_slice(&full[..DIGEST_LENGTH]);
    Ok(out)
}

fn random_vec<R: RngCore + ?Sized>(rng: &mut R, length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    rng.fill_bytes(&mut bytes);
    bytes
}

/// SplitSecret(T, N, S): one point per share index 0..N-1.
///
/// # Errors
/// [`Slip39Error::Parameters`] unless `0 < threshold <= share_count <= 16` and
/// the secret is at least 128 bits and a whole number of 16-bit words.
pub fn split_secret<R: RngCore + ?Sized>(
    threshold: u8,
    share_count: u8,
    secret: &[u8],
    rng: &mut R,
) -> Result<Vec<Point>, Slip39Error> {
    if threshold < 1 || threshold > share_count || share_count > 16 {
        return Err(Slip39Error::Parameters(
            "0 < threshold <= share count <= 16 is required",
        ));
    }
    if secret.len() < 16 || secret.len() % 2 != 0 {
        return Err(Slip39Error::Parameters(
            "the secret must be at least 128 bits and a whole number of 16-bit words",
        ));
    }
    if threshold == 1 {
        return Ok((0..share_count)
            .map(|x| Point {
                x,
                y: Secret::new(secret.to_vec()),
            })
            .collect());
    }
    let mut base: Vec<Point> = (0..threshold - 2)
        .map(|x| Point {
            x,
            y: Secret::new(random_vec(rng, secret.len())),
        })
        .collect();
    let mut shares = base.clone();
    let random_part = Zeroizing::new(random_vec(rng, secret.len() - DIGEST_LENGTH));
    let mut digest_value = digest_of(&random_part, secret)?.to_vec();
    digest_value.extend_from_slice(&random_part);
    base.push(Point {
        x: DIGEST_INDEX,
        y: Secret::new(digest_value),
    });
    base.push(Point {
        x: SECRET_INDEX,
        y: Secret::new(secret.to_vec()),
    });
    for x in threshold - 2..share_count {
        shares.push(Point {
            x,
            y: interpolate(&base, x)?,
        });
    }
    Ok(shares)
}

/// RecoverSecret(T, shares): the secret, or a refusal if the digest fails.
///
/// # Errors
/// [`Slip39Error::Digest`] when the shares do not agree on one polynomial.
pub fn recover_secret(threshold: u8, shares: &[Point]) -> Result<Secret, Slip39Error> {
    let first = shares.first().ok_or(Slip39Error::Empty)?;
    if threshold == 1 {
        return Ok(first.y.clone());
    }
    let secret = interpolate(shares, SECRET_INDEX)?;
    let digest_share = interpolate(shares, DIGEST_INDEX)?;
    let digest_share = digest_share.expose();
    let (actual, random_part) = digest_share.split_at(DIGEST_LENGTH.min(digest_share.len()));
    if digest_of(random_part, secret.expose())?.as_slice() != actual {
        return Err(Slip39Error::Digest);
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use rand::{rngs::StdRng, SeedableRng};

    use super::{recover_secret, split_secret};
    use crate::slip39::error::Slip39Error;

    #[test]
    fn splits_and_recovers_with_any_threshold_subset() {
        let mut rng = StdRng::seed_from_u64(7);
        let secret: Vec<u8> = (0..32).collect();
        let shares = split_secret(3, 5, &secret, &mut rng).unwrap();
        assert_eq!(shares.len(), 5);
        for picks in [[0, 1, 2], [4, 2, 0], [1, 3, 4]] {
            let chosen: Vec<_> = picks.iter().map(|&i| shares[i].clone()).collect();
            assert_eq!(recover_secret(3, &chosen).unwrap().expose(), &secret[..]);
        }
    }

    #[test]
    fn a_wrong_set_trips_the_digest() {
        let mut rng = StdRng::seed_from_u64(8);
        let secret = vec![9_u8; 16];
        let a = split_secret(2, 3, &secret, &mut rng).unwrap();
        let b = split_secret(2, 3, &secret, &mut rng).unwrap();
        let mixed = vec![a[0].clone(), b[1].clone()];
        assert_eq!(recover_secret(2, &mixed).unwrap_err(), Slip39Error::Digest);
    }

    #[test]
    fn threshold_one_copies_the_secret() {
        let mut rng = StdRng::seed_from_u64(9);
        let secret = vec![1_u8; 16];
        let shares = split_secret(1, 1, &secret, &mut rng).unwrap();
        assert_eq!(recover_secret(1, &shares).unwrap().expose(), &secret[..]);
    }

    #[test]
    fn refuses_bad_parameters() {
        let mut rng = StdRng::seed_from_u64(10);
        assert!(split_secret(0, 3, &[0; 16], &mut rng).is_err());
        assert!(split_secret(4, 3, &[0; 16], &mut rng).is_err());
        assert!(split_secret(2, 17, &[0; 16], &mut rng).is_err());
        assert!(split_secret(2, 3, &[0; 15], &mut rng).is_err());
        assert!(split_secret(2, 3, &[0; 17], &mut rng).is_err());
    }
}
