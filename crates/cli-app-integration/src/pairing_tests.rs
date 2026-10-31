use super::*;
use crate::root_trust::{fingerprint_of_spki, RootTrustRecord};
use crate::test_support::TEST_VAULT_SESSION_ROOT_DIGEST;
use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::PublicKey;

fn sign_pairing_confirm(key: &SigningKey, challenge: &[u8], code: &str, origin: &str) -> String {
    let message = pairing_confirm_message(challenge, code, origin);
    let sig: p256::ecdsa::Signature = key.sign(&message);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

fn device_key_b64() -> (SigningKey, String) {
    let key = SigningKey::generate();
    let vk = key.verifying_key();
    let spki = PublicKey::from(vk).to_public_key_der().expect("spki");
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki.as_ref());
    (key, b64)
}

fn enrolled_pairings() -> CliAppIntegrationPairings {
    let mut pairings = CliAppIntegrationPairings::default();
    assert!(!pairings.is_root_key_enrolled());
    let record = RootTrustRecord::new(fingerprint_of_spki(&[7u8; 32]), 1).expect("record");
    pairings.mark_root_key_enrolled(record);
    assert!(pairings.is_root_key_enrolled());
    pairings
}

#[test]
fn exchange_without_confirm_is_refused() {
    let mut pairings = enrolled_pairings();
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
    let mut pairings = enrolled_pairings();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    let outcome = pairings
        .confirm(
            &code,
            origin,
            &spki,
            &sig,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
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
fn confirm_without_arm_cannot_exchange_on_first_pairing() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 2_000;
    pairings.enroll_root_key_for_tests();
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    pairings
        .confirm(
            &code,
            origin,
            &spki,
            &sig,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
        .expect("confirm");
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
}

#[test]
fn persona_random_root_shaped_secret_cannot_confirm() {
    let mut pairings = enrolled_pairings();
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
    let mut pairings = enrolled_pairings();
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings.issue(origin, now).unwrap();
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    let outcome = pairings
        .confirm(
            &code,
            origin,
            &spki,
            &sig,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
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
        .confirm(
            &code2,
            origin,
            &spki,
            &sig2,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
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

/// Confirm never arms registration, and the four pairing operations stay closed until
/// the daemon root trust key is enrolled. Operator issue still mints a code.
#[test]
fn pairing_ops_refuse_until_root_key_enrolled() {
    let mut pairings = CliAppIntegrationPairings::default();
    assert!(!pairings.is_root_key_enrolled());
    let origin = "http://localhost:5180";
    let now = 1_000;
    let (code, _) = pairings
        .issue(origin, now)
        .expect("issue before enrollment");
    let (signing_key, spki) = device_key_b64();
    let challenge = pairings.pending[0].pairing_challenge;
    let sig = sign_pairing_confirm(&signing_key, &challenge, &code, origin);
    assert!(matches!(
        pairings.confirm(
            &code,
            origin,
            &spki,
            &sig,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        ),
        Err(PairingError::RootKeyNotEnrolled)
    ));
    assert!(pairings
        .pending
        .iter()
        .all(|pending| !pending.registration_armed));
    assert!(matches!(
        pairings.arm_registration(origin, "registration-code", now),
        Err(PairingError::RootKeyNotEnrolled)
    ));
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::RootKeyNotEnrolled)
    ));
    assert!(matches!(
        pairings.register_webauthn(
            "token",
            origin,
            &crate::WebAuthnRegistration {
                vault_session_root_digest: TEST_VAULT_SESSION_ROOT_DIGEST.to_string(),
                human_proof_passkey: "oschip2:passkey:{}".to_string(),
                credential_id_b64: "cred".to_string(),
                public_key_spki_b64: spki.clone(),
                sign_count: 1,
            },
        ),
        Err(PairingError::RootKeyNotEnrolled)
    ));
    assert!(!pairings.is_root_key_enrolled());
    assert!(pairings.root_trust().is_none());
    assert!(pairings
        .pending
        .iter()
        .all(|pending| !pending.registration_armed));
}

#[test]
fn mark_root_key_enrolled_keeps_the_store_record() {
    let mut pairings = CliAppIntegrationPairings::default();
    let first = RootTrustRecord::new(fingerprint_of_spki(b"one"), 1).expect("first");
    pairings.mark_root_key_enrolled(first.clone());
    assert_eq!(pairings.root_trust(), Some(&first));
    let second = RootTrustRecord::new(fingerprint_of_spki(b"two"), 2).expect("second");
    pairings.mark_root_key_enrolled(second.clone());
    assert!(pairings.is_root_key_enrolled());
    assert_eq!(pairings.root_trust(), Some(&second));
}

#[test]
fn test_seam_enrolls_without_a_trust_record() {
    let mut pairings = CliAppIntegrationPairings::default();
    pairings.enroll_root_key_for_tests();
    assert!(pairings.is_root_key_enrolled());
    assert!(pairings.root_trust().is_none());
}
