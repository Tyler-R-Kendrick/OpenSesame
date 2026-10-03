use super::*;
use chrono::Utc;
use opensesame_domain::*;

#[test]
fn a_secret_in_a_summary_value_is_scrubbed_before_the_receipt_is_signed() {
    let signer = ReceiptSigner::generate();
    let mut receipt = sample_receipt();
    receipt.safe_result_summary = Some(serde_json::json!({
        "status": "failed",
        "detail": "GET https://api.example/x?api_key=k_live_123 rejected; Authorization: Bearer abc.def.ghi",
    }));
    let output = signer.sign_receipt(receipt).unwrap();
    let stored = output.safe_result_summary.as_ref().unwrap().to_string();
    assert!(!stored.contains("k_live_123") && !stored.contains("abc.def.ghi"));
    assert!(stored.contains("failed"));
    signer
        .verify_receipt(&output)
        .expect("the signature covers the scrubbed summary");
}

#[test]
fn sign_and_verify() {
    let signer = ReceiptSigner::generate();
    let receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: InvocationId::new(),
        intent_digest: "sha256:x".into(),
        principal_id: PrincipalId::new(),
        organization_id: None,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        policy_decision_id: "dec:1".into(),
        policy_version_digest: "sha256:p".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: Some("sha256:c".into()),
        external_request_digest: None,
        external_response_digest: None,
        started_at: Utc::now(),
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(serde_json::json!({"ok": true})),
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: 1,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    let signed_receipt = signer.sign_receipt(receipt).unwrap();
    signer.verify_receipt(&signed_receipt).unwrap();
}

#[test]
fn tampered_receipt_fails_verify() {
    let signer = ReceiptSigner::generate();
    let receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: InvocationId::new(),
        intent_digest: "sha256:x".into(),
        principal_id: PrincipalId::new(),
        organization_id: None,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        policy_decision_id: "dec:1".into(),
        policy_version_digest: "sha256:p".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: Utc::now(),
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(serde_json::json!({"ok": true})),
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: 1,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    let mut signed_receipt = signer.sign_receipt(receipt).unwrap();
    signed_receipt.operation = "admin.destroy".into();
    assert!(signer.verify_receipt(&signed_receipt).is_err());
}

fn sample_receipt() -> InvocationReceipt {
    InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: InvocationId::new(),
        intent_digest: "sha256:x".into(),
        principal_id: PrincipalId::new(),
        organization_id: None,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        policy_decision_id: "dec:1".into(),
        policy_version_digest: "sha256:p".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: Utc::now(),
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(serde_json::json!({"ok": true})),
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: 1,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    }
}

#[test]
fn legacy_receipt_without_organization_round_trips_and_verifies() {
    let signer = ReceiptSigner::generate();
    let signed_receipt = signer.sign_receipt(sample_receipt()).unwrap();
    let encoded = serde_json::to_string(&signed_receipt).unwrap();
    assert!(!encoded.contains("organization_id"));

    let decoded: InvocationReceipt = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.organization_id, None);
    signer.verify_receipt(&decoded).unwrap();
}

#[test]
fn organization_claim_is_covered_by_the_receipt_signature() {
    let signer = ReceiptSigner::generate();
    let mut receipt = sample_receipt();
    receipt.organization_id = Some(OrganizationId::new());
    receipt.receipt_schema_version = 3;
    let mut signed_receipt = signer.sign_receipt(receipt).unwrap();
    signer.verify_receipt(&signed_receipt).unwrap();

    signed_receipt.organization_id = Some(OrganizationId::new());
    assert!(signer.verify_receipt(&signed_receipt).is_err());
}

#[test]
fn schema_three_without_an_organization_is_never_signed_or_verified() {
    let signer = ReceiptSigner::generate();
    let mut invalid = sample_receipt();
    invalid.receipt_schema_version = 3;
    let error = signer.sign_receipt(invalid).unwrap_err().to_string();
    assert!(
        error.contains("schema 3 requires organization_id"),
        "{error}"
    );

    let mut signed_legacy = signer.sign_receipt(sample_receipt()).unwrap();
    signed_legacy.receipt_schema_version = 3;
    let error = signer
        .verify_receipt(&signed_legacy)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("schema 3 requires organization_id"),
        "{error}"
    );
}

#[test]
fn a_seeded_signer_verifies_receipts_from_a_previous_process() {
    let seed = [7u8; 32];
    let before_restart = ReceiptSigner::from_seed(&seed);
    let signed = before_restart.sign_receipt(sample_receipt()).unwrap();

    // The store outlives the process: a restart must still verify the receipt.
    let after_restart = ReceiptSigner::from_seed(&seed);
    assert_eq!(after_restart.key_id, before_restart.key_id);
    after_restart.verify_receipt(&signed).unwrap();

    // An ephemeral key cannot, and says so rather than crying tamper.
    let ephemeral = ReceiptSigner::generate();
    let err = ephemeral.verify_receipt(&signed).unwrap_err().to_string();
    assert!(err.contains("another authority key"), "{err}");
}

#[test]
fn a_retired_key_keeps_verifying_the_receipts_it_signed() {
    let retired = ReceiptSigner::from_seed(&[9u8; 32]);
    let old_receipt = retired.sign_receipt(sample_receipt()).unwrap();
    let active = ReceiptSigner::from_seed(&[11u8; 32]);
    let new_receipt = active.sign_receipt(sample_receipt()).unwrap();

    // Rotation keeps only the public half of the old key.
    let mut verifier = ReceiptVerifier::new();
    verifier.trust(active.verifying_key());
    verifier
        .trust_b64(&STANDARD.encode(retired.verifying_key().as_bytes()))
        .unwrap();

    verifier.verify(&old_receipt).unwrap();
    verifier.verify(&new_receipt).unwrap();
    assert_eq!(verifier.key_ids().len(), 2);

    // A key that was never trusted is reported as unknown, not as tampering.
    let stranger = ReceiptSigner::generate();
    let foreign = stranger.sign_receipt(sample_receipt()).unwrap();
    let err = verifier.verify(&foreign).unwrap_err().to_string();
    assert!(err.contains("no trusted receipt key"), "{err}");

    // Tampering under a trusted key still fails the signature check.
    let mut tampered = old_receipt.clone();
    tampered.operation = "admin.destroy".into();
    assert!(verifier.verify(&tampered).is_err());
}

#[test]
fn published_keys_round_trip_into_a_fresh_verifier() {
    let signer = ReceiptSigner::from_seed(&[5u8; 32]);
    let receipt = signer.sign_receipt(sample_receipt()).unwrap();
    let mut source = ReceiptVerifier::new();
    source.trust(signer.verifying_key());

    // A holder can rebuild the verifier from the published material alone.
    let mut rebuilt = ReceiptVerifier::new();
    for (key_id, public_key) in source.published_keys() {
        assert_eq!(rebuilt.trust_b64(&public_key).unwrap(), key_id);
    }
    rebuilt.verify(&receipt).unwrap();
    assert!(!rebuilt.is_empty());
}

#[test]
fn an_empty_verifier_trusts_nothing() {
    let signer = ReceiptSigner::generate();
    let receipt = signer.sign_receipt(sample_receipt()).unwrap();
    assert!(ReceiptVerifier::new().verify(&receipt).is_err());
}

#[test]
fn seed_b64_accepts_both_alphabets_and_rejects_wrong_lengths() {
    let seed = [3u8; 32];
    let standard = STANDARD.encode(seed);
    let url_safe = URL_SAFE_NO_PAD.encode(seed);
    let expected = ReceiptSigner::from_seed(&seed).key_id;
    assert_eq!(
        ReceiptSigner::from_seed_b64(&standard).unwrap().key_id,
        expected
    );
    assert_eq!(
        ReceiptSigner::from_seed_b64(&url_safe).unwrap().key_id,
        expected
    );
    assert!(ReceiptSigner::from_seed_b64(&STANDARD.encode([1u8; 16])).is_err());
    assert!(ReceiptSigner::from_seed_b64("not base64!").is_err());
}

#[test]
fn refuses_to_sign_secret_bearing_summary() {
    let signer = ReceiptSigner::generate();
    let receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: InvocationId::new(),
        intent_digest: "sha256:x".into(),
        principal_id: PrincipalId::new(),
        organization_id: None,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: "x".into(),
        resource: "y".into(),
        policy_decision_id: "d".into(),
        policy_version_digest: "p".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: Utc::now(),
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(serde_json::json!({"refresh_token": "nope"})),
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: 1,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    assert!(signer.sign_receipt(receipt).is_err());
}
