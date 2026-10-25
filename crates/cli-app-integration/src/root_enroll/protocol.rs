//! Enrollment session: daemon mints the secret, client proves it, daemon
//! accepts one P-256 root SPKI.

use p256::elliptic_curve::ff::Field;
use p256::elliptic_curve::ops::Reduce;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::{PublicKey, Scalar};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::spake2::{
    mac_eq, message_a, message_b, random_scalar, scalar_from_bytes, scalar_to_bytes, schedule,
    shared_k_from_a, shared_k_from_b, Exchange,
};
use super::RootEnrollError;
use crate::root_trust::{fingerprint_of_spki, RootTrustRecord};
use crate::CliAppIntegrationHost;

/// Operator route that mints the enrollment secret and the daemon SPAKE2 message.
pub const ROOT_ENROLL_BEGIN_PATH: &str = "/v1/operator/cli-app-integration/root-trust/enroll/begin";
/// Client route that finishes enrollment. The secret is not on this request.
pub const ROOT_ENROLL_FINISH_PATH: &str = "/v1/cli/app-integration/root-trust/enroll";
/// Pending enrollment lifetime, matching pairing-code lifetime.
pub const ROOT_ENROLL_TTL_SECS: u64 = 300;

const CLIENT_ID: &[u8] = b"opensesame-cli-root-enroll/client";
const DAEMON_ID: &[u8] = b"opensesame-cli-root-enroll/daemon";
const AAD_PREFIX: &[u8] = b"opensesame-cli-root-enroll.v1";
const PASSWORD_LABEL: &[u8] = b"opensesame-cli-root-enroll.w.v1";

/// One pending enrollment. A new begin replaces it.
#[derive(Default)]
pub(crate) struct Sessions {
    pending: Option<Pending>,
}

struct Pending {
    id: String,
    expires_at: u64,
    y: Zeroizing<[u8; 32]>,
    w: Zeroizing<[u8; 32]>,
    p_b: [u8; 65],
}

/// Secret and daemon message returned once from begin.
pub struct RootEnrollBegin {
    /// Id the finish request must echo.
    pub session_id: String,
    /// One-time secret. The finish request does not carry it.
    pub enrollment_secret: Zeroizing<Vec<u8>>,
    /// Uncompressed daemon SPAKE2 message.
    pub daemon_message: Vec<u8>,
    /// Unix seconds when the session stops being acceptable.
    pub expires_at: u64,
}

/// Finish body the daemon checks against the pending session.
#[derive(Clone, Copy)]
pub struct RootEnrollRequest<'a> {
    /// Id from begin.
    pub session_id: &'a str,
    /// Uncompressed client SPAKE2 message.
    pub client_message: &'a [u8],
    /// Client key confirmation, 32 bytes.
    pub client_confirm: &'a [u8],
    /// P-256 `SubjectPublicKeyInfo` `DER` to enroll.
    pub root_spki_der: &'a [u8],
}

/// Record to persist, plus the daemon confirmation the client must check.
pub struct RootEnrollFinish {
    /// Fingerprint and epoch to write into the trust store.
    pub record: RootTrustRecord,
    /// Daemon key confirmation.
    pub daemon_confirm: [u8; 32],
}

/// Client confirmation and the daemon confirmation it expects.
pub struct EnrollmentConfirm {
    client_confirm: [u8; 32],
    expected_daemon: [u8; 32],
}

/// Enroller state after the client SPAKE2 message is computed.
pub struct RootEnrollClient {
    x: Zeroizing<[u8; 32]>,
    w: Zeroizing<[u8; 32]>,
    p_a: [u8; 65],
}

impl EnrollmentConfirm {
    /// Client confirmation to send with the root `SPKI`.
    #[must_use]
    pub fn client_confirm(&self) -> &[u8] {
        &self.client_confirm
    }

    /// Accept the daemon confirmation.
    ///
    /// # Errors
    ///
    /// Returns [`RootEnrollError::InvalidConfirm`] when the bytes do not match.
    pub fn verify_daemon(&self, daemon_confirm: &[u8]) -> Result<(), RootEnrollError> {
        if mac_eq(&self.expected_daemon, daemon_confirm) {
            Ok(())
        } else {
            Err(RootEnrollError::InvalidConfirm)
        }
    }
}

impl RootEnrollClient {
    /// Start from the enrollment secret and return the client message state.
    ///
    /// # Errors
    ///
    /// Returns [`RootEnrollError::InvalidSecret`] when `secret` is not 16 to
    /// 128 bytes or reduces to the zero scalar.
    pub fn start(secret: &[u8]) -> Result<Self, RootEnrollError> {
        let w = password_scalar(secret)?;
        let x = random_scalar();
        let p_a = message_a(&w, &x)?;
        Ok(Self {
            x: Zeroizing::new(scalar_to_bytes(&x)),
            w: Zeroizing::new(scalar_to_bytes(&w)),
            p_a,
        })
    }

    /// Uncompressed client SPAKE2 message.
    #[must_use]
    pub fn message(&self) -> &[u8] {
        &self.p_a
    }

    /// Key confirmation binding `root_spki_der` into the SPAKE2 associated data.
    ///
    /// # Errors
    ///
    /// Returns [`RootEnrollError::InvalidMessage`] when `daemon_message` is not
    /// an uncompressed P-256 point.
    pub fn confirm(
        &self,
        daemon_message: &[u8],
        root_spki_der: &[u8],
    ) -> Result<EnrollmentConfirm, RootEnrollError> {
        let p_b = as_point(daemon_message)?;
        let w = scalar_from_bytes(&self.w).ok_or(RootEnrollError::InvalidMessage)?;
        let x = scalar_from_bytes(&self.x).ok_or(RootEnrollError::InvalidMessage)?;
        let k = shared_k_from_a(&w, &x, &p_b)?;
        let mut w_bytes = scalar_to_bytes(&w);
        let keys = schedule(&Exchange {
            identity_a: CLIENT_ID,
            identity_b: DAEMON_ID,
            p_a: &self.p_a,
            p_b: &p_b,
            k: &k,
            w: &w_bytes,
            aad: &enroll_aad(root_spki_der),
        })?;
        w_bytes.zeroize();
        Ok(EnrollmentConfirm {
            client_confirm: keys.c_a,
            expected_daemon: keys.c_b,
        })
    }
}

impl CliAppIntegrationHost {
    /// Mint a one-time secret and remember the daemon's SPAKE2 state.
    ///
    /// A second call drops the previous pending session.
    ///
    /// # Errors
    ///
    /// Returns [`RootEnrollError::InvalidSecret`] only when a minted secret
    /// cannot be reduced, which a caller may retry.
    pub fn begin_root_enroll(&mut self, now: u64) -> Result<RootEnrollBegin, RootEnrollError> {
        for _ in 0..4 {
            let secret = random_secret();
            if let Ok(opened) = Pending::open(secret.as_slice(), now) {
                let (pending, message) = opened;
                let begun = RootEnrollBegin {
                    session_id: pending.id.clone(),
                    enrollment_secret: secret,
                    daemon_message: message.to_vec(),
                    expires_at: pending.expires_at,
                };
                self.root_enroll.pending = Some(pending);
                return Ok(begun);
            }
        }
        Err(RootEnrollError::InvalidSecret)
    }

    /// Check the client proof and build the trust-store record.
    ///
    /// Does not mark the key enrolled. The daemon marks it after the store
    /// write succeeds. The epoch is one more than the record already on the
    /// host, or 1 when none is loaded.
    ///
    /// # Errors
    ///
    /// Returns [`RootEnrollError`] when the session, proof, or `SPKI` is refused.
    pub fn finish_root_enroll(
        &mut self,
        request: RootEnrollRequest<'_>,
        now: u64,
    ) -> Result<RootEnrollFinish, RootEnrollError> {
        let epoch = next_epoch(self.pairings.root_trust())?;
        let Some(pending) = self.root_enroll.pending.take() else {
            return Err(RootEnrollError::UnknownSession);
        };
        if pending.id != request.session_id {
            self.root_enroll.pending = Some(pending);
            return Err(RootEnrollError::UnknownSession);
        }
        if pending.expires_at <= now {
            return Err(RootEnrollError::Expired);
        }
        pending.complete(&request, epoch)
    }
}

impl Pending {
    fn open(secret: &[u8], now: u64) -> Result<(Self, [u8; 65]), RootEnrollError> {
        let w = password_scalar(secret)?;
        let y = random_scalar();
        let p_b = message_b(&w, &y)?;
        let pending = Self {
            id: random_id(),
            expires_at: now.saturating_add(ROOT_ENROLL_TTL_SECS),
            y: Zeroizing::new(scalar_to_bytes(&y)),
            w: Zeroizing::new(scalar_to_bytes(&w)),
            p_b,
        };
        Ok((pending, p_b))
    }

    fn complete(
        &self,
        request: &RootEnrollRequest<'_>,
        epoch: u64,
    ) -> Result<RootEnrollFinish, RootEnrollError> {
        if request.root_spki_der.is_empty() || request.root_spki_der.len() > 128 {
            return Err(RootEnrollError::InvalidSpki);
        }
        let p_a = as_point(request.client_message)?;
        let client_confirm: [u8; 32] = request
            .client_confirm
            .try_into()
            .map_err(|_| RootEnrollError::InvalidConfirm)?;
        let w = scalar_from_bytes(&self.w).ok_or(RootEnrollError::InvalidMessage)?;
        let y = scalar_from_bytes(&self.y).ok_or(RootEnrollError::InvalidMessage)?;
        let k = shared_k_from_b(&w, &y, &p_a)?;
        let mut w_bytes = scalar_to_bytes(&w);
        let keys = schedule(&Exchange {
            identity_a: CLIENT_ID,
            identity_b: DAEMON_ID,
            p_a: &p_a,
            p_b: &self.p_b,
            k: &k,
            w: &w_bytes,
            aad: &enroll_aad(request.root_spki_der),
        })?;
        w_bytes.zeroize();
        if !mac_eq(&keys.c_a, &client_confirm) {
            return Err(RootEnrollError::InvalidConfirm);
        }
        parse_spki(request.root_spki_der)?;
        let record = RootTrustRecord::new(fingerprint_of_spki(request.root_spki_der), epoch)
            .map_err(|_| RootEnrollError::InvalidSpki)?;
        Ok(RootEnrollFinish {
            record,
            daemon_confirm: keys.c_b,
        })
    }
}

/// New P-256 root trust signing key. The daemon stores only the public `SPKI`.
#[must_use]
pub fn generate_root_signing_key() -> p256::ecdsa::SigningKey {
    p256::ecdsa::SigningKey::generate()
}

/// `SubjectPublicKeyInfo` `DER` for `key`.
///
/// # Panics
///
/// Panics when the P-256 verifying key cannot be encoded as `SPKI`, which
/// cannot happen for a valid P-256 key.
#[must_use]
pub fn root_spki_der(key: &p256::ecdsa::SigningKey) -> Vec<u8> {
    let public_key = PublicKey::from(*key.verifying_key());
    public_key
        .to_public_key_der()
        .expect("P-256 verifying key encodes as SPKI")
        .as_bytes()
        .to_vec()
}

fn next_epoch(current: Option<&RootTrustRecord>) -> Result<u64, RootEnrollError> {
    match current {
        None => Ok(1),
        Some(record) => record
            .enrollment_epoch()
            .checked_add(1)
            .ok_or(RootEnrollError::EpochExhausted),
    }
}

fn password_scalar(secret: &[u8]) -> Result<Scalar, RootEnrollError> {
    if !(16..=128).contains(&secret.len()) {
        return Err(RootEnrollError::InvalidSecret);
    }
    let mut hasher = Sha256::new();
    hasher.update(PASSWORD_LABEL);
    hasher.update([0u8]);
    hasher.update(secret);
    let digest = hasher.finalize();
    let reduced = Scalar::reduce(&p256::U256::from_be_slice(digest.as_slice()));
    if bool::from(reduced.is_zero()) {
        return Err(RootEnrollError::InvalidSecret);
    }
    Ok(reduced)
}

fn enroll_aad(root_spki_der: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + root_spki_der.len());
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(root_spki_der);
    aad
}

fn parse_spki(der: &[u8]) -> Result<(), RootEnrollError> {
    use p256::pkcs8::DecodePublicKey;
    p256::ecdsa::VerifyingKey::from_public_key_der(der)
        .map_err(|_| RootEnrollError::InvalidSpki)?;
    Ok(())
}

fn as_point(bytes: &[u8]) -> Result<[u8; 65], RootEnrollError> {
    bytes
        .try_into()
        .map_err(|_| RootEnrollError::InvalidMessage)
}

fn random_secret() -> Zeroizing<Vec<u8>> {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let secret = Zeroizing::new(raw.to_vec());
    raw.zeroize();
    secret
}

fn random_id() -> String {
    let mut raw = [0u8; 16];
    OsRng.fill_bytes(&mut raw);
    let id = hex::encode(raw);
    raw.zeroize();
    id
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
