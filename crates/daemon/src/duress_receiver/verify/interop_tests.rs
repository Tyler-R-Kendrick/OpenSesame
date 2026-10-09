//! Cross-implementation vectors against Pages `duress/peer/envelope.ts`:
//! the signing input must be the exact `JSON.stringify` byte string the
//! TypeScript signer produces, and a `WebCrypto` signature over it must
//! verify here.

use super::*;

fn ts_vector_view() -> PeerEnvelopeView {
    PeerEnvelopeView {
        schema_version: 1,
        alg: "ECDSA-P256-SHA256".into(),
        issuer: "peer".into(),
        audience: "recv".into(),
        principal_ref: "p".into(),
        vault_ref: "v".into(),
        device_binding_ref: "d".into(),
        operation: "quarantine_device".into(),
        incident_id: "i".into(),
        policy_revision: 1,
        key_epoch: 1,
        nonce: "nonce-ts-vector-001".into(),
        issued_at: "2026-01-01T00:00:00Z".into(),
        expires_at: "2026-01-01T00:01:00Z".into(),
        ciphertext_b64: "AAAA".into(),
        signature_b64: "DEHcEuie2ltyn/8l/LdrGuIRXMpSZ5+ANB0dIMywD8M9+qNAjHc5anxQx/wu4fRP19XcIfmRhdmR4rOuycETTw==".into(),
    }
}

#[test]
fn signing_input_matches_typescript_byte_order() {
    let expected = concat!(
        "{",
        "\"schemaVersion\":1,",
        "\"alg\":\"ECDSA-P256-SHA256\",",
        "\"issuer\":\"peer\",",
        "\"audience\":\"recv\",",
        "\"principalRef\":\"p\",",
        "\"vaultRef\":\"v\",",
        "\"deviceBindingRef\":\"d\",",
        "\"operation\":\"quarantine_device\",",
        "\"incidentId\":\"i\",",
        "\"policyRevision\":1,",
        "\"keyEpoch\":1,",
        "\"nonce\":\"nonce-ts-vector-001\",",
        "\"issuedAt\":\"2026-01-01T00:00:00Z\",",
        "\"expiresAt\":\"2026-01-01T00:01:00Z\",",
        "\"ciphertextB64\":\"AAAA\"",
        "}"
    );
    assert_eq!(
        String::from_utf8(signing_input_bytes(&ts_vector_view())).unwrap(),
        expected
    );
}

#[test]
fn verifies_webcrypto_signature_over_typescript_signing_input() {
    // SPKI + signature produced by WebCrypto (Node `crypto.subtle`, P-256 /
    // SHA-256, IEEE P1363) over the exact `signingInput` bytes above.
    let vk = parse_verifying_key_b64(
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZgiqv2QQ1NiPyEfEhbgPab4VBpbHC9GjqDxBZI6Ld2E09PXXuUW3SwUaowqouLAgxf++Dq14P3q8v5vf9de3Gg==",
    )
    .unwrap();
    let expect = EnvelopeVerifyExpect {
        audience: "recv".into(),
        permitted_operations: vec!["quarantine_device".into()],
        vault_ref: None,
        now_ms: Some(1_767_225_630_000),
    };
    let mut replay = ReplayCache::new(16);
    assert!(verify_envelope_view(&ts_vector_view(), &expect, &mut replay, Some(&vk)).is_ok());
}
