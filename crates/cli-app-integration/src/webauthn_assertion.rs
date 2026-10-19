//! Minimal `WebAuthn` assertion verification for CLI app-integration passkey proofs.

use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::device_crypto::{parse_verifying_key_spki_b64, verify_p256_sha256};
use crate::pairing::WebAuthnCredential;

#[derive(Debug, Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    ty: String,
    challenge: String,
}

#[derive(Debug, Deserialize)]
struct AssertionWire {
    #[serde(rename = "credentialIdB64")]
    credential_id: String,
    #[serde(rename = "authenticatorDataB64")]
    authenticator_data: String,
    #[serde(rename = "clientDataJsonB64")]
    client_data_json: String,
    #[serde(rename = "signatureB64")]
    signature: String,
}

fn b64_decode(value: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(value.trim()))
        .ok()
}

fn challenge_matches(client_challenge_b64: &str, expected_digest: &[u8; 32]) -> bool {
    let Some(decoded) = b64_decode(client_challenge_b64) else {
        return false;
    };
    if decoded.len() == 32 {
        return decoded.as_slice() == expected_digest;
    }
    let Some(as_text) = String::from_utf8(decoded).ok() else {
        return false;
    };
    let Some(inner) = b64_decode(as_text.trim()) else {
        return false;
    };
    inner.len() == 32 && inner.as_slice() == expected_digest
}

fn user_verified(auth_data: &[u8]) -> bool {
    auth_data.len() >= 33 && auth_data[32] & 0x04 != 0
}

fn sign_count(auth_data: &[u8]) -> Option<u32> {
    if auth_data.len() < 37 {
        return None;
    }
    let bytes = auth_data[33..37].try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

/// Verifies `oschip2:passkey:` JSON payload against the stored credential.
#[must_use]
pub fn verify_passkey_assertion(
    proof_tail: &str,
    expected_challenge: &[u8; 32],
    stored: &WebAuthnCredential,
) -> Option<u32> {
    let wire: AssertionWire = serde_json::from_str(proof_tail).ok()?;
    if wire.credential_id != stored.credential_id_b64 {
        return None;
    }
    let client_data_bytes = b64_decode(&wire.client_data_json)?;
    let client_data: ClientData = serde_json::from_slice(&client_data_bytes).ok()?;
    if client_data.ty != "webauthn.get" {
        return None;
    }
    if !challenge_matches(&client_data.challenge, expected_challenge) {
        return None;
    }
    let auth_data = b64_decode(&wire.authenticator_data)?;
    if !user_verified(&auth_data) {
        return None;
    }
    let new_count = sign_count(&auth_data)?;
    // A counter that stays 0 is a counterless authenticator (WebAuthn), not a replay.
    let counterless = new_count == 0 && stored.sign_count == 0;
    if !counterless && new_count <= stored.sign_count {
        return None;
    }
    let client_hash = Sha256::digest(&client_data_bytes);
    let mut signed = auth_data;
    signed.extend_from_slice(&client_hash);
    let verifying_key = parse_verifying_key_spki_b64(&stored.public_key_spki_b64)?;
    if !verify_p256_sha256(&verifying_key, &signed, &wire.signature) {
        return None;
    }
    Some(new_count)
}
