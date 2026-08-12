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
fn weak_and_misshaped_proof_keys_are_refused() {
    use crate::jwk::assert_proof_key_strength;
    use jsonwebtoken::jwk::{
        AlgorithmParameters, CommonParameters, EllipticCurve, Jwk, OctetKeyPairParameters,
        OctetKeyPairType, RSAKeyParameters, RSAKeyType,
    };

    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let rsa = |modulus: Vec<u8>, exponent: Vec<u8>| Jwk {
        common: CommonParameters::default(),
        algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
            key_type: RSAKeyType::RSA,
            n: b64(&modulus),
            e: b64(&exponent),
        }),
    };
    // A high bit in the first byte so the modulus is its full nominal length.
    let modulus = |bytes: usize| {
        let mut n = vec![0xffu8; bytes];
        n[0] = 0x80;
        n
    };

    // 1024 bits is a modulus an observer can factor, and once they hold the
    // private key the token's confirmation claim confirms them.
    assert!(matches!(
        assert_proof_key_strength(&rsa(modulus(128), vec![1, 0, 1])),
        Err(ProofError::WeakProofKey(_))
    ));
    assert!(assert_proof_key_strength(&rsa(modulus(256), vec![1, 0, 1])).is_ok());

    // Leading zero bytes are padding, not strength.
    let mut padded = vec![0u8; 128];
    padded.extend_from_slice(&modulus(128));
    assert!(matches!(
        assert_proof_key_strength(&rsa(padded, vec![1, 0, 1])),
        Err(ProofError::WeakProofKey(_))
    ));

    // e = 1 makes the signature the message; an even exponent is not one at all.
    for exponent in [vec![1u8], vec![0u8], vec![4u8]] {
        assert!(
            matches!(
                assert_proof_key_strength(&rsa(modulus(256), exponent.clone())),
                Err(ProofError::WeakProofKey(_))
            ),
            "exponent {exponent:?} should be refused"
        );
    }

    // An Ed25519 key is 32 bytes; a short or long `x` is not one.
    let okp = |x: Vec<u8>, curve: EllipticCurve| Jwk {
        common: CommonParameters::default(),
        algorithm: AlgorithmParameters::OctetKeyPair(OctetKeyPairParameters {
            key_type: OctetKeyPairType::OctetKeyPair,
            curve,
            x: b64(&x),
        }),
    };
    assert!(matches!(
        assert_proof_key_strength(&okp(vec![1u8; 16], EllipticCurve::Ed25519)),
        Err(ProofError::WeakProofKey(_))
    ));
    assert!(assert_proof_key_strength(&okp(vec![1u8; 32], EllipticCurve::Ed25519)).is_ok());
    // P-256 is not an OKP curve, whatever the JWK claims.
    assert!(matches!(
        assert_proof_key_strength(&okp(vec![1u8; 32], EllipticCurve::P256)),
        Err(ProofError::UnsupportedAlgorithm(_))
    ));
}

#[test]
fn a_proof_signed_by_a_weak_rsa_key_does_not_validate() {
    use jsonwebtoken::jwk::{
        AlgorithmParameters, CommonParameters, Jwk, RSAKeyParameters, RSAKeyType,
    };
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let mut n = vec![0xffu8; 128];
    n[0] = 0x80;
    let weak = Jwk {
        common: CommonParameters::default(),
        algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
            key_type: RSAKeyType::RSA,
            n: b64(&n),
            e: b64(&[1, 0, 1]),
        }),
    };
    // Header carries the weak key; the strength check fires before any signature
    // work, so the proof is refused on the key rather than on the signature.
    let header = serde_json::json!({"typ": "dpop+jwt", "alg": "RS256", "jwk": weak});
    let claims = sample_claims(1_700_000_000);
    let jwt = format!(
        "{}.{}.signature-not-reached",
        b64(&serde_json::to_vec(&header).unwrap()),
        b64(&serde_json::to_vec(&claims).unwrap())
    );
    let err = decode_dpop_proof(
        &jwt,
        "POST",
        "https://api.example/resource",
        None,
        300,
        1_700_000_000,
    )
    .unwrap_err();
    assert!(matches!(err, ProofError::WeakProofKey(_)), "{err:?}");
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
