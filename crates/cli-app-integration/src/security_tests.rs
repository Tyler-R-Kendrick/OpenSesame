//! D7-2 adversarial regression tests (same-user attacker personas).

use super::*;
use crate::device_crypto::pairing_confirm_message;
use crate::human_proof::{mint_pin_human_proof, mint_test_signing_key, HumanProofContext};
use crate::test_support::{
    ensure_params, ensure_params_full, mint_register_passkey_proof, mint_test_human_proof,
    pair_browser_for_tests, test_approval_public_key_spki_b64, test_paired_binding,
    TEST_VAULT_SESSION_ROOT_DIGEST,
};
use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::PublicKey;
use sha2::{Digest, Sha256};

fn sign_confirm(key: &SigningKey, challenge: &[u8], code: &str, origin: &str) -> String {
    let message = pairing_confirm_message(challenge, code, origin);
    let sig: p256::ecdsa::Signature = key.sign(&message);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

fn argv_hash_hex(argv: &[String]) -> String {
    let joined = argv.join("\0");
    hex::encode(Sha256::digest(joined.as_bytes()))
}

fn device_spki(key: &SigningKey) -> String {
    let vk = key.verifying_key();
    let spki = PublicKey::from(*vk).to_public_key_der().expect("spki");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki.as_ref())
}

#[test]
fn first_pairing_requires_host_arm_not_auto_arm() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 1_000;
    pairings.enroll_root_key_for_tests();
    let (code, _) = pairings.issue(origin, now).unwrap();
    let attacker = SigningKey::generate();
    let challenge = pairings.pairing_challenge_for_code(&code, now).unwrap();
    let sig = sign_confirm(&attacker, &challenge, &code, origin);
    let outcome = pairings
        .confirm(
            &code,
            origin,
            &device_spki(&attacker),
            &sig,
            Some(crate::test_support::TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
        .expect("confirm");
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
    pairings
        .arm_registration(origin, &outcome.registration_code, now)
        .expect("host arms");
    assert!(pairings.exchange(&code, origin, now).is_ok());
}

#[test]
fn enroll_through_attacker_pty_with_self_minted_key_fails_without_arm() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 2_000;
    pairings.enroll_root_key_for_tests();
    let (code, _) = pairings.issue(origin, now).unwrap();
    let attacker = SigningKey::generate();
    let challenge = pairings.pairing_challenge_for_code(&code, now).unwrap();
    let sig = sign_confirm(&attacker, &challenge, &code, origin);
    assert!(pairings
        .confirm(
            &code,
            origin,
            &device_spki(&attacker),
            &sig,
            Some(crate::test_support::TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
        .is_ok());
    assert!(matches!(
        pairings.exchange(&code, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
}

#[test]
fn client_supplied_webauthn_registration_rejected() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 3_000;
    let token = pair_browser_for_tests(&mut pairings, origin, now);
    // Client-supplied SPKI alone is not trusted: main's vault-bound register
    // rejects an SPKI equal to the pairing device key and requires a passkey
    // assertion over the register challenge (see ADR 0206 decision 2).
    let device_spki = crate::test_support::test_device_public_key_spki_b64().to_string();
    assert!(matches!(
        pairings.register_webauthn(
            &token,
            origin,
            &crate::WebAuthnRegistration {
                vault_session_root_digest: crate::test_support::TEST_VAULT_SESSION_ROOT_DIGEST
                    .to_string(),
                human_proof_passkey: "oschip2:passkey:{}".to_string(),
                credential_id_b64: "cred".to_string(),
                public_key_spki_b64: device_spki,
                sign_count: 0,
            },
        ),
        Err(PairingError::InvalidProof)
    ));
}

#[test]
fn webauthn_register_stores_the_verified_sign_count() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let token = pair_browser_for_tests(&mut pairings, origin, 4_000);
    assert_eq!(
        pairings
            .binding_for(&token, origin)
            .expect("binding")
            .webauthn
            .expect("cred")
            .sign_count,
        1
    );
    pairings
        .register_webauthn(
            &token,
            origin,
            &WebAuthnRegistration {
                vault_session_root_digest: TEST_VAULT_SESSION_ROOT_DIGEST.to_string(),
                human_proof_passkey: mint_register_passkey_proof(&token, origin, 0),
                credential_id_b64: "test-cli-app-cred".to_string(),
                public_key_spki_b64: test_approval_public_key_spki_b64().to_string(),
                sign_count: 99,
            },
        )
        .expect("register");
    assert_eq!(
        pairings
            .binding_for(&token, origin)
            .expect("binding")
            .webauthn
            .expect("cred")
            .sign_count,
        0
    );
    assert!(pairings.advance_webauthn_sign_count(&token, origin, 0));
    assert_eq!(
        pairings
            .binding_for(&token, origin)
            .expect("binding")
            .webauthn
            .expect("cred")
            .sign_count,
        0
    );
    assert!(pairings.advance_webauthn_sign_count(&token, origin, 2));
    assert!(!pairings.advance_webauthn_sign_count(&token, origin, 2));
    assert!(!pairings.advance_webauthn_sign_count(&token, origin, 0));
}

#[test]
fn pending_queue_keeps_the_first_request_when_a_second_arrives() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let (_, a) = store.ensure(ensure_params_full(
        "term-a", "read", false, "00", 10, 1, true,
    ));
    let a_id = a.expect("first pending");
    let (_, b) = store.ensure(ensure_params_full(
        "term-b", "read", false, "00", 11, 1, true,
    ));
    let b_id = b.expect("second pending");
    let listed = store.list_pending();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].request_id, a_id);
    let nonce = listed[0].respond_nonce.clone();
    let proof = mint_test_human_proof(&a_id, "term-a", &nonce, "read", 10, 1);
    assert_eq!(
        store
            .approve(&a_id, "term-a", &nonce, &proof, &test_paired_binding())
            .0,
        "approved"
    );
    let left = store.list_pending();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].request_id, b_id);
}

#[test]
fn pending_queue_denies_past_the_cap_without_clearing() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let ids: Vec<String> = (0..8).map(|i| format!("term-{i}")).collect();
    for id in &ids {
        let (status, request_id) = store.ensure(ensure_params(id, "read"));
        assert_eq!(status, "pending");
        assert!(request_id.is_some());
    }
    let (status, overflow) = store.ensure(ensure_params("term-overflow", "read"));
    assert_eq!(status, "denied");
    assert!(overflow.is_none());
    assert_eq!(store.list_pending().len(), 8);
    let first = store.list_pending()[0].clone();
    assert_eq!(
        store.deny(
            &first.request_id,
            &first.terminal_session_id,
            &first.respond_nonce
        ),
        "denied"
    );
    let (status, queued) = store.ensure(ensure_params("term-overflow", "read"));
    assert_eq!(status, "pending");
    assert!(queued.is_some());
    assert_eq!(store.list_pending().len(), 8);
}

#[test]
fn tcp_pending_cannot_be_approved() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let (_, req) = store.ensure(ensure_params_full(
        "term-tcp-1",
        "read",
        false,
        "00",
        0,
        0,
        false,
    ));
    let request_id = req.expect("pending");
    let row = store
        .list_pending()
        .into_iter()
        .find(|r| r.request_id == request_id)
        .unwrap();
    let proof = mint_test_human_proof(
        &request_id,
        "term-tcp-1",
        &row.respond_nonce,
        "read",
        row.peer_pid,
        row.peer_start_time,
    );
    let nonce = row.respond_nonce.clone();
    assert_eq!(
        store
            .approve(
                &request_id,
                "term-tcp-1",
                &nonce,
                &proof,
                &test_paired_binding(),
            )
            .0,
        "wrongSession"
    );
}

#[test]
fn passkey_registered_rejects_ark_only_pin_proof() {
    let mut pairings = CliAppIntegrationPairings::default();
    let origin = "http://localhost:5180";
    let now = 4_000;
    let token = pair_browser_for_tests(&mut pairings, origin, now);
    let spki = crate::test_support::test_device_public_key_spki_b64();
    pairings
        .register_webauthn_for_tests(&token, origin, "cred", spki, 0)
        .expect("test seam");
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let (_, req) = store.ensure(ensure_params_full(
        "term-a", "read", false, "00", 1, 1, true,
    ));
    let request_id = req.unwrap();
    let row = store
        .list_pending()
        .into_iter()
        .find(|r| r.request_id == request_id)
        .unwrap();
    let ctx = HumanProofContext {
        daemon_id: daemon_integration_id(),
        request_id: request_id.clone(),
        terminal_session_id: "term-a".into(),
        respond_nonce: row.respond_nonce.clone(),
        verb: "read".into(),
        argv_hash: row.argv_hash.clone(),
        peer_pid: row.peer_pid,
        peer_start_time: row.peer_start_time,
    };
    let proof = mint_pin_human_proof(&mint_test_signing_key(), &ctx);
    let binding = pairings.binding_for(&token, origin).unwrap();
    let nonce = row.respond_nonce.clone();
    assert_eq!(
        store
            .approve(&request_id, "term-a", &nonce, &proof, &binding)
            .0,
        "wrongSession"
    );
}

#[test]
fn argv_hash_binds_approval() {
    let argv = vec!["opensesame".into(), "read".into(), "--reveal".into()];
    let h1 = argv_hash_hex(&argv);
    let mut argv2 = argv.clone();
    argv2[2] = "run".into();
    let h2 = argv_hash_hex(&argv2);
    assert_ne!(h1, h2);
}

#[test]
fn upgrade_wipes_legacy_pairings() {
    let mut host = CliAppIntegrationHost::new();
    let origin = "http://localhost:5180";
    let now = 5_000;
    let _token = pair_browser_for_tests(&mut host.pairings, origin, now);
    assert_eq!(host.pairings.paired_len(), 1);
    host.wipe_legacy_pairings_on_trust_upgrade();
    assert_eq!(host.pairings.paired_len(), 0);
}

#[test]
fn oschip2_proofs_rejected() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let (_, req) = store.ensure(ensure_params("term-a", "read"));
    let request_id = req.unwrap();
    let row = store
        .list_pending()
        .into_iter()
        .find(|r| r.request_id == request_id)
        .unwrap();
    let legacy = "oschip2:pin:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let nonce = row.respond_nonce.clone();
    assert_eq!(
        store
            .approve(
                &request_id,
                "term-a",
                &nonce,
                legacy,
                &test_paired_binding()
            )
            .0,
        "wrongSession"
    );
}

#[test]
fn proof_with_wrong_argv_hash_is_rejected() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let argv_a = argv_hash_hex(&["opensesame".into(), "read".into()]);
    let (_, req) = store.ensure(ensure_params_full(
        "term-a", "read", false, &argv_a, 1, 1, true,
    ));
    let request_id = req.unwrap();
    let row = store
        .list_pending()
        .into_iter()
        .find(|r| r.request_id == request_id)
        .unwrap();
    let argv_b = argv_hash_hex(&["opensesame".into(), "run".into()]);
    let ctx = HumanProofContext {
        daemon_id: daemon_integration_id(),
        request_id: request_id.clone(),
        terminal_session_id: "term-a".into(),
        respond_nonce: row.respond_nonce.clone(),
        verb: "read".into(),
        argv_hash: argv_b,
        peer_pid: row.peer_pid,
        peer_start_time: row.peer_start_time,
    };
    let proof = mint_pin_human_proof(&mint_test_signing_key(), &ctx);
    let nonce = row.respond_nonce.clone();
    assert_eq!(
        store
            .approve(
                &request_id,
                "term-a",
                &nonce,
                &proof,
                &test_paired_binding(),
            )
            .0,
        "wrongSession"
    );
}
