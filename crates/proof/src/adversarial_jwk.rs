//! Negative controls for unsupported proof key variants.

use crate::{decode_dpop_proof, ed25519_jwk_from_seed, sign_dpop_proof, DpopClaims, ProofError};
use base64::Engine;

#[test]
fn unrecognized_and_malformed_jwk_types_are_refused() {
    use crate::jwk::{assert_proof_key_strength, jwk_thumbprint};
    use jsonwebtoken::jwk::{AlgorithmParameters, Jwk};

    let (_, encoding_key) = ed25519_jwk_from_seed(&[7u8; 32]);
    let claims = DpopClaims {
        jti: "test-jti-1".into(),
        htm: "POST".into(),
        htu: "https://api.example/resource".into(),
        iat: 1_700_000_000,
        ath: None,
    };
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    for value in [
        serde_json::json!({"kty": "future-key", "x": "AQ"}),
        serde_json::json!({"kty": "EC", "crv": "future-curve", "x": "AQ", "y": "AQ"}),
    ] {
        let jwk: Jwk = serde_json::from_value(value.clone()).expect("unknown JWK is representable");
        assert!(matches!(&jwk.algorithm, AlgorithmParameters::Other(_)));
        assert!(matches!(
            assert_proof_key_strength(&jwk),
            Err(ProofError::UnsupportedAlgorithm(_))
        ));
        assert!(jwk_thumbprint(&jwk).is_err());
        assert!(matches!(
            sign_dpop_proof(&jwk, &encoding_key, &claims),
            Err(ProofError::UnsupportedAlgorithm(_))
        ));

        // A key represented as Other cannot become an accepted self-signed proof.
        let header = serde_json::json!({"typ": "dpop+jwt", "alg": "EdDSA", "jwk": value});
        let compact_proof = format!(
            "{}.{}.signature-not-reached",
            b64(&serde_json::to_vec(&header).unwrap()),
            b64(&serde_json::to_vec(&claims).unwrap())
        );
        let error = decode_dpop_proof(
            &compact_proof,
            "POST",
            "https://api.example/resource",
            None,
            300,
            1_700_000_000,
        )
        .unwrap_err();
        assert!(
            matches!(error, ProofError::UnsupportedAlgorithm(_)),
            "{error:?}"
        );
    }
}
