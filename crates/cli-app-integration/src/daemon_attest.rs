//! Daemon attestation for CLI pin verification (loopback MITM resistance).

use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::{DecodePrivateKey, EncodePublicKey};
use p256::PublicKey;
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::device_crypto::{daemon_attest_message, verify_p256_sha256};

static DAEMON_ATTEST_KEY: OnceLock<Option<SigningKey>> = OnceLock::new();

fn signing_key() -> Option<&'static SigningKey> {
    DAEMON_ATTEST_KEY
        .get_or_init(load_signing_key_from_env)
        .as_ref()
}

fn load_signing_key_from_env() -> Option<SigningKey> {
    let raw = std::env::var("OPENSESAME_CLI_APP_INTEGRATION_DAEMON_ATTEST_PKCS8_B64")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    let trimmed = raw.trim();
    let der = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(trimmed))
        .ok()?;
    SigningKey::from_pkcs8_der(&der).ok()
}

/// SPKI (url-safe base64) for the operator pin file when the env key is configured.
#[must_use]
pub fn daemon_attest_public_key_spki_b64() -> Option<String> {
    let key = signing_key()?;
    let public_key = PublicKey::from(key.verifying_key());
    let der = public_key.to_public_key_der().ok()?;
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(der.as_ref()))
}

#[must_use]
pub fn sign_daemon_attest(nonce: &str) -> Option<String> {
    let key = signing_key()?;
    let message = daemon_attest_message(nonce);
    let sig: p256::ecdsa::Signature = key.sign(&message);
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

/// Stable id for human-proof binding (hash of daemon attest SPKI when configured).
#[must_use]
pub fn daemon_integration_id() -> String {
    match daemon_attest_public_key_spki_b64() {
        Some(spki) => hex::encode(Sha256::digest(spki.as_bytes())),
        None => "ephemeral-no-attest".to_string(),
    }
}

#[must_use]
pub fn verify_daemon_attest(public_key_spki_b64: &str, nonce: &str, signature_b64: &str) -> bool {
    let Some(verifying_key) =
        crate::device_crypto::parse_verifying_key_spki_b64(public_key_spki_b64)
    else {
        return false;
    };
    let message = daemon_attest_message(nonce);
    verify_p256_sha256(&verifying_key, &message, signature_b64)
}
