//! Shared test keys for conformance and daemon integration tests.

use base64::Engine as _;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::PublicKey;
use serde_json::json;

use crate::daemon_attest::daemon_integration_id;
use crate::device_crypto::{
    approval_challenge_digest_v3, pairing_confirm_message, webauthn_register_challenge_digest,
    ApprovalChallengeDigestV3,
};
use crate::human_proof::{mint_pin_human_proof, HumanProofContext};
use crate::pairing::{CliAppIntegrationPairings, PairedBinding, WebAuthnCredential};
use crate::EnsureParams;
use ecdsa::signature::Signer;

/// Default [`EnsureParams`] for conformance and security tests.
#[must_use]
pub fn ensure_params<'a>(terminal_session_id: &'a str, verb: &'a str) -> EnsureParams<'a> {
    ensure_params_full(terminal_session_id, verb, false, "00", 0, 0, true)
}

/// Full [`EnsureParams`] for session store conformance and security tests.
#[must_use]
pub fn ensure_params_full<'a>(
    terminal_session_id: &'a str,
    verb: &'a str,
    reuse_approved_session: bool,
    argv_hash: &'a str,
    peer_pid: u32,
    peer_start_time: u64,
    approvable: bool,
) -> EnsureParams<'a> {
    EnsureParams {
        terminal_session_id,
        verb,
        reference: None,
        reuse_approved_session,
        argv_hash,
        peer_pid,
        peer_start_time,
        approvable,
    }
}

static TEST_PAIRING: std::sync::OnceLock<(SigningKey, String)> = std::sync::OnceLock::new();
static TEST_APPROVAL: std::sync::OnceLock<(SigningKey, String)> = std::sync::OnceLock::new();

pub const TEST_VAULT_SESSION_ROOT_DIGEST: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn pairing_fixture() -> &'static (SigningKey, String) {
    TEST_PAIRING.get_or_init(|| {
        let key = SigningKey::generate();
        let public_key = PublicKey::from(key.verifying_key());
        let spki = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(public_key.to_public_key_der().expect("spki").as_ref());
        (key, spki)
    })
}

fn approval_fixture() -> &'static (SigningKey, String) {
    TEST_APPROVAL.get_or_init(|| {
        let key = SigningKey::generate();
        let public_key = PublicKey::from(key.verifying_key());
        let spki = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(public_key.to_public_key_der().expect("spki").as_ref());
        (key, spki)
    })
}

#[must_use]
pub fn test_device_public_key_spki_b64() -> &'static str {
    &pairing_fixture().1
}

#[must_use]
pub fn test_approval_public_key_spki_b64() -> &'static str {
    &approval_fixture().1
}

#[must_use]
pub fn test_webauthn_credential() -> WebAuthnCredential {
    WebAuthnCredential {
        credential_id_b64: "test-cli-app-cred".into(),
        public_key_spki_b64: test_approval_public_key_spki_b64().to_string(),
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

fn passkey_wire_for_challenge(
    signing_key: &SigningKey,
    credential_id: &str,
    challenge: [u8; 32],
    sign_count: u32,
) -> String {
    use sha2::{Digest, Sha256};

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
    let sig: p256::ecdsa::Signature = signing_key.sign(&signed);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    let wire = json!({
        "credentialIdB64": credential_id,
        "authenticatorDataB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&auth_data),
        "clientDataJsonB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(client_data_bytes),
        "signatureB64": sig_b64,
    });
    wire.to_string()
}

fn mint_passkey_proof_for_challenge(
    signing_key: &SigningKey,
    credential_id: &str,
    challenge: [u8; 32],
    sign_count: u32,
) -> String {
    format!(
        "oschip2:passkey:{}",
        passkey_wire_for_challenge(signing_key, credential_id, challenge, sign_count)
    )
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
    pairings.enroll_root_key_for_tests();
    let (code, _) = pairings.issue(origin, now).expect("issue");
    let challenge = pairings
        .pairing_challenge_for_code(&code, now)
        .expect("pending challenge");
    let message = pairing_confirm_message(&challenge, &code, origin);
    let sig: p256::ecdsa::Signature = pairing_fixture().0.sign(&message);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    let outcome = pairings
        .confirm(
            &code,
            origin,
            test_device_public_key_spki_b64(),
            &sig_b64,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
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
    let register_challenge =
        webauthn_register_challenge_digest(&token, origin, TEST_VAULT_SESSION_ROOT_DIGEST);
    let human_proof = mint_passkey_proof_for_challenge(
        &approval_fixture().0,
        "test-cli-app-cred",
        register_challenge,
        1,
    );
    pairings
        .register_webauthn(
            &token,
            origin,
            &crate::WebAuthnRegistration {
                vault_session_root_digest: TEST_VAULT_SESSION_ROOT_DIGEST.to_string(),
                human_proof_passkey: human_proof,
                credential_id_b64: "test-cli-app-cred".to_string(),
                public_key_spki_b64: test_approval_public_key_spki_b64().to_string(),
                sign_count: 1,
            },
        )
        .expect("register webauthn");
    token
}

/// PIN human proof for daemon persona tests (verb `read`, argv `"00"`, no peer).
#[must_use]
pub fn mint_test_pin_proof(
    signing_key: &SigningKey,
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
) -> String {
    mint_pin_human_proof(
        signing_key,
        &test_human_proof_ctx(request_id, terminal_session_id, respond_nonce),
    )
}

/// Human-proof context for daemon persona tests (verb `read`, argv `"00"`, no peer).
#[must_use]
pub fn test_human_proof_ctx(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
) -> HumanProofContext {
    HumanProofContext {
        daemon_id: daemon_integration_id(),
        request_id: request_id.to_string(),
        terminal_session_id: terminal_session_id.to_string(),
        respond_nonce: respond_nonce.to_string(),
        verb: "read".to_string(),
        argv_hash: "00".to_string(),
        peer_pid: 0,
        peer_start_time: 0,
    }
}

/// Register-challenge passkey proof. `sign_count` is the authenticator counter in the assertion.
#[must_use]
pub fn mint_register_passkey_proof(token: &str, origin: &str, sign_count: u32) -> String {
    let challenge =
        webauthn_register_challenge_digest(token, origin, TEST_VAULT_SESSION_ROOT_DIGEST);
    mint_passkey_proof_for_challenge(
        &approval_fixture().0,
        "test-cli-app-cred",
        challenge,
        sign_count,
    )
}

/// Mint a passkey-shaped human proof for integration tests (registered `WebAuthn` cred).
#[must_use]
pub fn mint_test_human_proof(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
    peer_pid: u32,
    peer_start_time: u64,
) -> String {
    let challenge = approval_challenge_digest_v3(&ApprovalChallengeDigestV3 {
        daemon_id: &daemon_integration_id(),
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
        argv_hash: "00",
        peer_pid,
        peer_start_time,
    });
    let wire = passkey_wire_for_challenge(&approval_fixture().0, "test-cli-app-cred", challenge, 2);
    format!("oschip3:passkey:{wire}")
}

#[must_use]
pub fn mint_test_passkey_human_proof(
    request_id: &str,
    terminal_session_id: &str,
    respond_nonce: &str,
    verb: &str,
    sign_count: u32,
) -> String {
    let challenge = approval_challenge_digest_v3(&ApprovalChallengeDigestV3 {
        daemon_id: &daemon_integration_id(),
        request_id,
        terminal_session_id,
        respond_nonce,
        verb,
        argv_hash: "00",
        peer_pid: 0,
        peer_start_time: 0,
    });
    let wire = passkey_wire_for_challenge(
        &approval_fixture().0,
        "test-cli-app-cred",
        challenge,
        sign_count,
    );
    format!("oschip3:passkey:{wire}")
}
