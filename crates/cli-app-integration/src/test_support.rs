//! Shared test keys for conformance and daemon integration tests.

use base64::Engine as _;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::PublicKey;
use rand_core::OsRng;

use crate::device_crypto::pairing_confirm_message;
use crate::human_proof::mint_pin_human_proof;
use crate::pairing::{CliAppIntegrationPairings, PairedBinding};
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
pub fn test_paired_binding() -> PairedBinding {
    PairedBinding {
        device_public_key_spki_b64: test_device_public_key_spki_b64().to_string(),
        webauthn: None,
        pin_proof_failures: 0,
    }
}

#[must_use]
/// Mint a bearer for daemon HTTP integration tests.
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
    pairings
        .exchange(&code, origin, now)
        .expect("exchange")
        .token
}

#[must_use]
pub fn mint_test_human_proof(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
) -> String {
    mint_pin_human_proof(
        &fixture().0,
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
    )
}
