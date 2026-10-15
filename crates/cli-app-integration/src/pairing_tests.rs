use super::*;
use crate::test_support::TEST_VAULT_SESSION_ROOT_DIGEST;
use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::PublicKey;

fn sign_pairing_confirm(key: &SigningKey, challenge: &[u8], code: &str, origin: &str) -> String {
    let message = pairing_confirm_message(challenge, code, origin);
    let sig: p256::ecdsa::Signature = key.sign(&message);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

fn device_key_b64() -> (SigningKey, String) {
    let key = SigningKey::random(&mut OsRng);
    let vk = key.verifying_key();
    let spki = PublicKey::from(vk).to_public_key_der().expect("spki");
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki.as_ref());
    (key, b64)
}

#[test]
fn exchange_without_confirm_is_refused() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::NotConfirmed)
    ));
}

#[test]
fn confirm_then_arm_then_exchange_mints_bearer() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    let outcome = pairings
        .confirm(&code, origin, &spki, &sig, Some(TEST_VAULT_SESSION_ROOT_DIGEST), now)
        .expect("confirm");
    pairings
        .arm_registration(origin, &outcome.registration_code, now)
        .expect("arm");
    let issued = pairings.exchange(&code, origin, now).unwrap();
    assert!(is_secret_shaped(&issued.token));
    assert!(pairings.authorizes(&issued.token, origin));
}

/// Persona: operator-minted code + forged Origin + well-formed random root cannot confirm.
#[test]
fn persona_random_root_shaped_secret_cannot_confirm() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let forged_origin = "https://attacker.github.io";
    let challenge = pairings
        .pairing_challenge_for_code(&code, now)
        .expect("challenge");
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, forged_origin);
    assert!(matches!(
        pairings.confirm(
            &code,
            forged_origin,
            &spki,
            &sig,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        ),
        Err(PairingError::WrongOrigin | PairingError::Unknown)
    ));
}

#[test]
fn exchange_requires_operator_armed_registration_every_time() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    let outcome = pairings
        .confirm(&code, origin, &spki, &sig, Some(TEST_VAULT_SESSION_ROOT_DIGEST), now)
        .expect("confirm");
    assert!(!pairings.pending[0].registration_armed);
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
    pairings
        .arm_registration(origin, &outcome.registration_code, now)
        .expect("arm");
    let issued = pairings.exchange(&code, origin, now).unwrap();
    assert!(pairings.authorizes(&issued.token, origin));

    let (code2, _) = pairings.issue(origin, now).unwrap();
    let sig2 = sign_pairing_confirm(
        &signing_key,
        &pairings.pending[0].pairing_challenge,
        &code2,
        origin,
    );
    let outcome2 = pairings
        .confirm(&code2, origin, &spki, &sig2, Some(TEST_VAULT_SESSION_ROOT_DIGEST), now)
        .expect("confirm second");
    assert!(!pairings.pending.iter().any(|p| p.registration_armed));
    assert!(matches!(
        pairings.exchange(&code2, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
    pairings
        .arm_registration(origin, &outcome2.registration_code, now)
        .expect("arm second");
    assert!(pairings.exchange(&code2, origin, now).is_ok());
}
