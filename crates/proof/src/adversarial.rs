//! Adversarial tests for DPoP validation and key custody.

use crate::{
    assert_token_presentation, decode_dpop_proof, reject_dpop_bound_as_bearer, sign_dpop_proof,
    AuthorizedProofRequest, DpopClaims, DpopValidator, InMemoryReplayCache, KeyCustodyProvider,
    LocalSoftwareKeyCustodyProvider, ProofError,
};
use base64::Engine;
use jsonwebtoken::EncodingKey;
use opensesame_domain::{
    ProofPurpose, ProtocolProfile, TaskRunId, TokenPresentation,
    PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1,
};

fn test_keypair() -> ([u8; 32], crate::DpopPublicJwk, EncodingKey) {
    let seed = [7u8; 32];
    let (jwk, encoding_key) = crate::ed25519_jwk_from_seed(&seed);
    (seed, jwk, encoding_key)
}

fn sample_claims(now: i64) -> DpopClaims {
    DpopClaims {
        jti: "test-jti-1".into(),
        htm: "POST".into(),
        htu: "https://api.example/resource".into(),
        iat: now,
        ath: None,
    }
}

#[test]
fn dpop_validation_success() {
    let (_, jwk, encoding_key) = test_keypair();
    let now = 1_700_000_000i64;
    let claims = sample_claims(now);
    let proof = sign_dpop_proof(&jwk, &encoding_key, &claims).expect("sign proof");

    let cache = InMemoryReplayCache::new();
    let validator = DpopValidator::new(cache, 300);
    let result = validator.validate(
        Some(&proof),
        "POST",
        "https://api.example/resource",
        now,
        None,
        None,
    );
    assert!(result.is_ok(), "{result:?}");
    let validated = result.unwrap();
    assert_eq!(validated.jti, "test-jti-1");
    assert!(!validated.jkt.is_empty());
}

#[test]
fn dpop_missing_proof_rejected() {
    let cache = InMemoryReplayCache::new();
    let validator = DpopValidator::new(cache, 300);
    let err = validator
        .validate(None, "GET", "https://api.example/x", 0, None, None)
        .unwrap_err();
    assert_eq!(err, ProofError::MissingProof);
}

#[test]
fn dpop_wrong_key_rejected() {
    let (_, jwk, encoding_key) = test_keypair();
    let (_, wrong_jwk, _) = {
        let seed = [9u8; 32];
        let (jwk, key) = crate::ed25519_jwk_from_seed(&seed);
        (seed, jwk, key)
    };
    let now = 1_700_000_000i64;
    let claims = sample_claims(now);
    let proof = sign_dpop_proof(&jwk, &encoding_key, &claims).unwrap();

    // Tamper header JWK to wrong key while signature remains from original key.
    let parts: Vec<&str> = proof.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header_json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .unwrap();
    let mut header: serde_json::Value = serde_json::from_slice(&header_json).unwrap();
    header["jwk"] = serde_json::to_value(&wrong_jwk).unwrap();
    let encoded_header = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&header).unwrap());
    let tampered = format!("{}.{}.{}", encoded_header, parts[1], parts[2]);

    let cache = InMemoryReplayCache::new();
    let validator = DpopValidator::new(cache, 300);
    let err = validator
        .validate(
            Some(&tampered),
            "POST",
            "https://api.example/resource",
            now,
            None,
            None,
        )
        .unwrap_err();
    assert!(
        matches!(err, ProofError::InvalidProof(_)),
        "expected invalid proof, got {err:?}"
    );
}

#[test]
fn bearer_downgrade_rejected() {
    let profile = ProtocolProfile::parse_slug(PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1).unwrap();
    let err = assert_token_presentation(&profile, TokenPresentation::Bearer).unwrap_err();
    assert_eq!(err, ProofError::TokenPresentationDowngrade);

    assert!(reject_dpop_bound_as_bearer(true, "Bearer").is_err());
    assert!(reject_dpop_bound_as_bearer(false, "Bearer").is_ok());
    assert!(reject_dpop_bound_as_bearer(true, "DPoP").is_ok());
}

#[test]
fn dpop_replay_rejected() {
    let (_, jwk, encoding_key) = test_keypair();
    let now = 1_700_000_000i64;
    let claims = sample_claims(now);
    let proof = sign_dpop_proof(&jwk, &encoding_key, &claims).unwrap();

    let cache = InMemoryReplayCache::new();
    let validator = DpopValidator::new(cache, 300);
    assert!(validator
        .validate(
            Some(&proof),
            "POST",
            "https://api.example/resource",
            now,
            None,
            None
        )
        .is_ok());
    let err = validator
        .validate(
            Some(&proof),
            "POST",
            "https://api.example/resource",
            now,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(err, ProofError::Replay("test-jti-1".into()));
}

#[test]
fn signing_oracle_mismatch_rejected() {
    let custody = LocalSoftwareKeyCustodyProvider::from_ed25519_seed([1u8; 32]).unwrap();
    let task_run_id = TaskRunId::new();

    let authorized = AuthorizedProofRequest {
        purpose: ProofPurpose::ResourceAccess,
        task_run_id,
        task_state_digest: "sha256:abc".into(),
        intent_digest: None,
        htm: "POST".into(),
        htu: "https://api.example/r".into(),
        access_token_hash: None,
    };
    custody.authorize(&authorized).unwrap();

    let mismatched = AuthorizedProofRequest {
        purpose: ProofPurpose::ResourceAccess,
        task_run_id,
        task_state_digest: "sha256:def".into(),
        intent_digest: None,
        htm: "POST".into(),
        htu: "https://api.example/r".into(),
        access_token_hash: None,
    };
    let err = custody.sign_dpop(&mismatched).unwrap_err();
    assert!(matches!(err, ProofError::SigningOracleMismatch(_)));

    // Unauthorized signing without prior authorize().
    let custody2 = LocalSoftwareKeyCustodyProvider::from_ed25519_seed([2u8; 32]).unwrap();
    let err2 = custody2.sign_dpop(&authorized).unwrap_err();
    assert!(matches!(err2, ProofError::UnauthorizedProofRequest(_)));
}

#[test]
fn cnf_jkt_mismatch_rejected() {
    let (_, jwk, encoding_key) = test_keypair();
    let now = 1_700_000_000i64;
    let claims = sample_claims(now);
    let proof = sign_dpop_proof(&jwk, &encoding_key, &claims).unwrap();

    let cache = InMemoryReplayCache::new();
    let validator = DpopValidator::new(cache, 300);
    let err = validator
        .validate(
            Some(&proof),
            "POST",
            "https://api.example/resource",
            now,
            None,
            Some("wrong-jkt"),
        )
        .unwrap_err();
    assert_eq!(err, ProofError::ConfirmationThumbprintMismatch);
}

#[test]
fn ath_mismatch_rejected() {
    let (_, jwk, encoding_key) = test_keypair();
    let now = 1_700_000_000i64;
    let mut claims = sample_claims(now);
    claims.ath = Some(crate::access_token_hash("token-a"));
    let proof = sign_dpop_proof(&jwk, &encoding_key, &claims).unwrap();

    let err = decode_dpop_proof(
        &proof,
        "POST",
        "https://api.example/resource",
        Some(&crate::access_token_hash("token-b")),
        300,
        now,
    )
    .unwrap_err();
    assert_eq!(err, ProofError::AccessTokenHashMismatch);
}
