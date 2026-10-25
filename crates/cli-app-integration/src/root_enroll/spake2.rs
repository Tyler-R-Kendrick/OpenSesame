//! RFC 9382 SPAKE2 over P-256 with SHA-256, HKDF, and HMAC.
//!
//! `M` and `N` are the P-256 points from the RFC. Messages and the shared
//! element `K` use uncompressed SEC1. The P-256 cofactor is 1.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::elliptic_curve::ff::{Field, PrimeField};
use p256::elliptic_curve::sec1::{FromSec1Point, ToSec1Point};
use p256::elliptic_curve::subtle::ConstantTimeEq;
use p256::elliptic_curve::Group;
use p256::Sec1Point;
use p256::{AffinePoint, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::RootEnrollError;

type HmacSha256 = Hmac<Sha256>;

const M_COMPRESSED: &str = "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f";
const N_COMPRESSED: &str = "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49";

pub(crate) struct Exchange<'a> {
    pub identity_a: &'a [u8],
    pub identity_b: &'a [u8],
    pub p_a: &'a [u8; 65],
    pub p_b: &'a [u8; 65],
    pub k: &'a [u8; 65],
    pub w: &'a [u8; 32],
    pub aad: &'a [u8],
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct Schedule {
    pub ke: [u8; 16],
    pub ka: [u8; 16],
    pub kc_a: [u8; 16],
    pub kc_b: [u8; 16],
    pub c_a: [u8; 32],
    pub c_b: [u8; 32],
}

#[cfg(test)]
pub(crate) struct Transcript {
    pub p_a: [u8; 65],
    pub p_b: [u8; 65],
    pub k: [u8; 65],
    pub ke: [u8; 16],
    pub ka: [u8; 16],
    pub kc_a: [u8; 16],
    pub kc_b: [u8; 16],
    pub c_a: [u8; 32],
    pub c_b: [u8; 32],
}

pub(crate) fn scalar_from_bytes(bytes: &[u8; 32]) -> Option<Scalar> {
    let scalar = Scalar::from_repr((*bytes).into()).into_option()?;
    if bool::from(scalar.is_zero()) {
        return None;
    }
    Some(scalar)
}

pub(crate) fn scalar_to_bytes(scalar: &Scalar) -> [u8; 32] {
    let bytes = scalar.to_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes.as_slice());
    out
}

pub(crate) fn random_scalar() -> Scalar {
    use rand_core::{OsRng, RngCore};
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(scalar) = scalar_from_bytes(&bytes) {
            bytes.zeroize();
            return scalar;
        }
        bytes.zeroize();
    }
}

pub(crate) fn mac_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    bool::from(left.ct_eq(right))
}

pub(crate) fn message_a(w: &Scalar, x: &Scalar) -> Result<[u8; 65], RootEnrollError> {
    let point = ProjectivePoint::GENERATOR * x + ProjectivePoint::from(base_m()) * w;
    encode_uncompressed(&point)
}

pub(crate) fn message_b(w: &Scalar, y: &Scalar) -> Result<[u8; 65], RootEnrollError> {
    let point = ProjectivePoint::GENERATOR * y + ProjectivePoint::from(base_n()) * w;
    encode_uncompressed(&point)
}

pub(crate) fn shared_k_from_a(
    w: &Scalar,
    x: &Scalar,
    p_b: &[u8; 65],
) -> Result<[u8; 65], RootEnrollError> {
    let peer = decode_uncompressed(p_b)?;
    let mask = ProjectivePoint::from(base_n()) * w;
    encode_uncompressed(&((peer - mask) * x))
}

pub(crate) fn shared_k_from_b(
    w: &Scalar,
    y: &Scalar,
    p_a: &[u8; 65],
) -> Result<[u8; 65], RootEnrollError> {
    let peer = decode_uncompressed(p_a)?;
    let mask = ProjectivePoint::from(base_m()) * w;
    encode_uncompressed(&((peer - mask) * y))
}

pub(crate) fn schedule(exchange: &Exchange<'_>) -> Result<Schedule, RootEnrollError> {
    let tt = transcript(exchange);
    let digest = Sha256::digest(&tt);
    let mut ke = [0u8; 16];
    let mut ka = [0u8; 16];
    ke.copy_from_slice(&digest[..16]);
    ka.copy_from_slice(&digest[16..]);
    let (kc_a, kc_b) = confirmation_keys(&ka, exchange.aad)?;
    let c_a = hmac_sha256(&kc_a, &tt)?;
    let c_b = hmac_sha256(&kc_b, &tt)?;
    Ok(Schedule {
        ke,
        ka,
        kc_a,
        kc_b,
        c_a,
        c_b,
    })
}

#[cfg(test)]
pub(crate) fn evaluate(
    identity_a: &[u8],
    identity_b: &[u8],
    w: &Scalar,
    x: &Scalar,
    y: &Scalar,
    aad: &[u8],
) -> Result<Transcript, RootEnrollError> {
    let p_a = message_a(w, x)?;
    let p_b = message_b(w, y)?;
    let k_a = shared_k_from_a(w, x, &p_b)?;
    let k_b = shared_k_from_b(w, y, &p_a)?;
    if !mac_eq(&k_a, &k_b) {
        return Err(RootEnrollError::InvalidMessage);
    }
    let w_bytes = scalar_to_bytes(w);
    let keys = schedule(&Exchange {
        identity_a,
        identity_b,
        p_a: &p_a,
        p_b: &p_b,
        k: &k_a,
        w: &w_bytes,
        aad,
    })?;
    Ok(Transcript {
        p_a,
        p_b,
        k: k_a,
        ke: keys.ke,
        ka: keys.ka,
        kc_a: keys.kc_a,
        kc_b: keys.kc_b,
        c_a: keys.c_a,
        c_b: keys.c_b,
    })
}

fn confirmation_keys(ka: &[u8; 16], aad: &[u8]) -> Result<([u8; 16], [u8; 16]), RootEnrollError> {
    let hk = Hkdf::<Sha256>::new(None, ka);
    let mut info = Vec::with_capacity(16 + aad.len());
    info.extend_from_slice(b"ConfirmationKeys");
    info.extend_from_slice(aad);
    let mut okm = [0u8; 32];
    hk.expand(&info, &mut okm)
        .map_err(|_| RootEnrollError::InvalidMessage)?;
    let mut kc_a = [0u8; 16];
    let mut kc_b = [0u8; 16];
    kc_a.copy_from_slice(&okm[..16]);
    kc_b.copy_from_slice(&okm[16..]);
    okm.zeroize();
    Ok((kc_a, kc_b))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Result<[u8; 32], RootEnrollError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| RootEnrollError::InvalidMessage)?;
    mac.update(message);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
}

fn transcript(exchange: &Exchange<'_>) -> Vec<u8> {
    let mut tt = Vec::with_capacity(320);
    for item in [
        exchange.identity_a,
        exchange.identity_b,
        exchange.p_a.as_slice(),
        exchange.p_b.as_slice(),
        exchange.k.as_slice(),
        exchange.w.as_slice(),
    ] {
        push_item(&mut tt, item);
    }
    tt
}

fn push_item(out: &mut Vec<u8>, item: &[u8]) {
    let len = u64::try_from(item.len()).unwrap_or(u64::MAX);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(item);
}

fn encode_uncompressed(point: &ProjectivePoint) -> Result<[u8; 65], RootEnrollError> {
    if bool::from(point.is_identity()) {
        return Err(RootEnrollError::InvalidMessage);
    }
    let encoded = point.to_affine().to_sec1_point(false);
    let bytes = encoded.as_bytes();
    if bytes.len() != 65 || bytes[0] != 0x04 {
        return Err(RootEnrollError::InvalidMessage);
    }
    let mut out = [0u8; 65];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn decode_uncompressed(bytes: &[u8; 65]) -> Result<ProjectivePoint, RootEnrollError> {
    if bytes[0] != 0x04 {
        return Err(RootEnrollError::InvalidMessage);
    }
    let encoded =
        Sec1Point::from_bytes(bytes.as_slice()).map_err(|_| RootEnrollError::InvalidMessage)?;
    let affine = AffinePoint::from_sec1_point(&encoded)
        .into_option()
        .ok_or(RootEnrollError::InvalidMessage)?;
    if bool::from(affine.is_identity()) {
        return Err(RootEnrollError::InvalidMessage);
    }
    Ok(ProjectivePoint::from(affine))
}

fn decode_compressed(hex_bytes: &str) -> AffinePoint {
    let raw = hex::decode(hex_bytes).expect("constant point hex");
    let encoded = Sec1Point::from_bytes(raw.as_slice()).expect("constant point bytes");
    AffinePoint::from_sec1_point(&encoded)
        .into_option()
        .expect("RFC 9382 P-256 base point")
}

fn base_m() -> AffinePoint {
    static POINT: OnceLock<AffinePoint> = OnceLock::new();
    *POINT.get_or_init(|| decode_compressed(M_COMPRESSED))
}

fn base_n() -> AffinePoint {
    static POINT: OnceLock<AffinePoint> = OnceLock::new();
    *POINT.get_or_init(|| decode_compressed(N_COMPRESSED))
}

#[cfg(test)]
#[path = "spake2_tests.rs"]
mod tests;
