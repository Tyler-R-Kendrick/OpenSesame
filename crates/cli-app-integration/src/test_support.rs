//! Shared test keys for conformance and daemon integration tests.

use base64::Engine as _;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::PublicKey;
use rand_core::OsRng;
use serde_json::json;

use crate::device_crypto::pairing_confirm_message;
use crate::pairing::{CliAppIntegrationPairings, PairedBinding, WebAuthnCredential};
use ecdsa::signature::Signer;

static TEST_SIGNING: std::sync::OnceLock<(SigningKey, String)> = std::sync::OnceLock::new();

fn fixture() -> &'static (SigningKey, String) {
    TEST_SIGNING.get_or_init(|| {
        let key = SigningKey::random(&mut OsRng);
        let public_key = PublicKey::from(key.verifying_key());
        let spki = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(public_key.to_public_key_der().expect("spki").as_ref());
        (key, spki)
    })
}

#[must_use]
pub fn test_device_public_key_spki_b64() -> &'static str {
    &fixture().1
}

#[must_use]
pub fn test_webauthn_credential() -> WebAuthnCredential {
    WebAuthnCredential {
        credential_id_b64: "test-cli-app-cred".into(),
        public_key_spki_b64: test_device_public_key_spki_b64().to_string(),
        sign_count: 0,
    }
}

#[must_use]
pub fn test_paired_binding() -> PairedBinding {
    PairedBinding {
        device_public_key_spki_b64: test_device_public_key_spki_b64().to_string(),
        webauthn: Some(test_webauthn_credential()),
        pin_proof_failures: 0,
    }
}

/// Mint a bearer for daemon HTTP integration tests.
///
/// # Panics
///
/// Panics when pairing issue, confirm, arm, or exchange fails in the test harness.
#[must_use]
pub fn pair_browser_for_tests(
    pairings: &mut CliAppIntegrationPairings,
    origin: &str,
    now: u64,
) -> String {
    let (code, _) = pairings.issue(origin, now).expect("issue");
    let challenge = pairings
        .pairing_challenge_for_code(&code, now)
        .expect("pending challenge");
    let message = pairing_confirm_message(&challenge, &code, origin);
    let sig: p256::ecdsa::Signature = fixture().0.sign(&message);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    let outcome = pairings
        .confirm(
            &code,
            origin,
            test_device_public_key_spki_b64(),
            &sig_b64,
            now,
        )
        .expect("confirm");
    pairings
        .arm_registration(origin, &outcome.registration_code, now)
        .expect("arm");
    let token = pairings
        .exchange(&code, origin, now)
        .expect("exchange")
        .token;
    pairings
        .register_webauthn(
            &token,
            origin,
            "test-cli-app-cred",
            test_device_public_key_spki_b64(),
            0,
        )
        .expect("register webauthn");
    token
}

/// Mint a passkey-shaped human proof for integration tests (registered `WebAuthn` cred).
#[must_use]
pub fn mint_test_human_proof(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    mint_test_passkey_human_proof(
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
        1,
    )
}

#[must_use]
pub fn mint_test_passkey_human_proof(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
    sign_count: u32,
) -> String {
    use crate::device_crypto::approval_challenge_digest;
    use sha2::{Digest, Sha256};

    let challenge = approval_challenge_digest(request_id, terminal_session_id, respond_nonce, verb);
    let challenge_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge);
    let client_data_json = json!({
        "type": "webauthn.get",
        "challenge": challenge_b64,
    })
    .to_string();
    let client_data_bytes = client_data_json.as_bytes();
    let client_hash = Sha256::digest(client_data_bytes);
    let mut auth_data = vec![0u8; 37];
    auth_data[32] = 0x05;
    auth_data[33..37].copy_from_slice(&sign_count.to_be_bytes());
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&client_hash);
    let sig: p256::ecdsa::Signature = fixture().0.sign(&signed);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    let wire = json!({
        "credentialIdB64": "test-cli-app-cred",
        "authenticatorDataB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&auth_data),
        "clientDataJsonB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(client_data_bytes),
        "signatureB64": sig_b64,
    });
    format!("oschip2:passkey:{}", wire)
}
