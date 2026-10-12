//! The labeled key derivation of RFC 9180 section 4: `LabeledExtract` and
//! `LabeledExpand` over HKDF-SHA256, and the two suite identifiers they label.

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::{HpkeAead, HpkeError};
use crate::secret::Secret;

const KEM_ID: u16 = 0x0020;
const KDF_ID: u16 = 0x0001;
const VERSION: &[u8] = b"HPKE-v1";

pub(super) fn kem_suite() -> Vec<u8> {
    let mut suite = b"KEM".to_vec();
    suite.extend_from_slice(&KEM_ID.to_be_bytes());
    suite
}

pub(super) fn hpke_suite(aead: HpkeAead) -> Vec<u8> {
    let mut suite = b"HPKE".to_vec();
    suite.extend_from_slice(&KEM_ID.to_be_bytes());
    suite.extend_from_slice(&KDF_ID.to_be_bytes());
    suite.extend_from_slice(&aead.id().to_be_bytes());
    suite
}

/// `LabeledExtract(salt, label, ikm)`: the pseudorandom key.
pub(super) fn labeled_extract(suite: &[u8], salt: &[u8], label: &str, ikm: &[u8]) -> Secret {
    let mut labeled = Zeroizing::new(VERSION.to_vec());
    labeled.extend_from_slice(suite);
    labeled.extend_from_slice(label.as_bytes());
    labeled.extend_from_slice(ikm);
    let (prk, _) = Hkdf::<Sha256>::extract(Some(salt), &labeled);
    Secret::new(prk.to_vec())
}

/// `LabeledExpand(prk, label, info, length)`.
pub(super) fn labeled_expand(
    suite: &[u8],
    prk: &[u8],
    label: &str,
    info: &[u8],
    length: usize,
) -> Result<Secret, HpkeError> {
    let length_field = u16::try_from(length).map_err(|_| HpkeError::Length)?;
    let mut labeled = length_field.to_be_bytes().to_vec();
    labeled.extend_from_slice(VERSION);
    labeled.extend_from_slice(suite);
    labeled.extend_from_slice(label.as_bytes());
    labeled.extend_from_slice(info);
    let hkdf = Hkdf::<Sha256>::from_prk(prk).map_err(|_| HpkeError::Length)?;
    let mut out = Zeroizing::new(vec![0_u8; length]);
    hkdf.expand(&labeled, &mut out)
        .map_err(|_| HpkeError::Length)?;
    Ok(Secret::new(std::mem::take(&mut *out)))
}
