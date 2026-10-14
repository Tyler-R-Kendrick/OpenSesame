//! P-256 signatures for CLI app-integration pairing and approvals.

use base64::Engine as _;
use ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use sha2::{Digest, Sha256};

pub const PAIRING_CONFIRM_LABEL: &[u8] = b"opensesame-cli-app-pairing-confirm.v1";
pub const APPROVAL_CHALLENGE_LABEL: &[u8] = b"opensesame-cli-app-approval.v1";
pub const DAEMON_ATTEST_LABEL: &[u8] = b"opensesame-cli-app-daemon-attest.v1";

/// SHA-256 over the frozen approval binding (`WebAuthn` challenge + ECDSA message).
#[must_use]
pub fn approval_challenge_digest(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> [u8; 32] {
    let mut msg = Vec::from(APPROVAL_CHALLENGE_LABEL);
    msg.push(0);
    for part in [request_id, terminal_session_id, respond_nonce, verb] {
        msg.extend_from_slice(part.as_bytes());
        msg.push(0);
    }
    let digest = Sha256::digest(&msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[must_use]
pub fn pairing_confirm_message(challenge: &[u8], code: &str, origin: &str) -> Vec<u8> {
    let mut msg = Vec::from(PAIRING_CONFIRM_LABEL);
    msg.push(0);
    msg.extend_from_slice(challenge);
    msg.push(0);
    msg.extend_from_slice(code.as_bytes());
    msg.push(0);
    msg.extend_from_slice(origin.as_bytes());
    msg
}

#[cfg(any(test, feature = "test-seams"))]
#[allow(dead_code)] // `test-seams` is enabled for the daemon crate; unit tests are the callers.
#[must_use]
pub fn verifying_key_spki_b64(verifying_key: &VerifyingKey) -> String {
    use p256::elliptic_curve::pkcs8::EncodePublicKey;
    use p256::PublicKey;
    let public_key = PublicKey::from(*verifying_key);
    let der = public_key
        .to_public_key_der()
        .expect("device verifying key encodes as SPKI");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(der.as_ref())
}

#[must_use]
pub fn daemon_attest_message(nonce: &str) -> Vec<u8> {
    let mut msg = Vec::from(DAEMON_ATTEST_LABEL);
    msg.push(0);
    msg.extend_from_slice(nonce.as_bytes());
    msg
}

#[must_use]
pub fn parse_verifying_key_spki_b64(b64: &str) -> Option<VerifyingKey> {
    let trimmed = b64.trim();
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(trimmed))
        .ok()?;
    VerifyingKey::from_public_key_der(&raw)
        .or_else(|_| VerifyingKey::from_sec1_bytes(&raw))
        .ok()
}

#[must_use]
pub fn verify_p256_sha256(verifying_key: &VerifyingKey, message: &[u8], sig_b64: &str) -> bool {
    let sig_raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig_b64.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()));
    let Ok(sig_raw) = sig_raw else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&sig_raw) else {
        return false;
    };
    verifying_key.verify(message, &signature).is_ok()
}

#[must_use]
pub fn is_registration_code_shaped(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit())
}
