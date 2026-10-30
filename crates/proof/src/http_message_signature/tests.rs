use super::*;
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

fn fixture() -> (SigningKey, LocalHttpMessageSignatureValidator) {
    let mut seed = Zeroizing::new([0u8; 32]);
    OsRng
        .try_fill_bytes(&mut *seed)
        .expect("system RNG unavailable");
    let signing_key = SigningKey::from_bytes(&seed);
    let mut validator = LocalHttpMessageSignatureValidator::new(300);
    validator.register_signing_key("test-key", &signing_key);
    (signing_key, validator)
}

#[test]
fn valid_signature_accepts() {
    let (signing_key, validator) = fixture();
    let body = br#"{"hello":"world"}"#;
    let signed = sign_request(
        &signing_key,
        "test-key",
        "POST",
        "https://host.example/api/v1/tasks",
        body,
        chrono::Utc::now().timestamp(),
    );
    assert!(validator.validate(&signed).is_ok());
}

#[test]
fn mutated_body_rejects() {
    let (signing_key, validator) = fixture();
    let body = br#"{"hello":"world"}"#;
    let mut signed = sign_request(
        &signing_key,
        "test-key",
        "POST",
        "https://host.example/api/v1/tasks",
        body,
        chrono::Utc::now().timestamp(),
    );
    signed.content_digest = content_digest_sha256(b"mutated");
    assert!(validator.validate(&signed).is_err());
}

#[test]
fn replay_signature_with_different_content_rejects() {
    let (signing_key, validator) = fixture();
    let body = br#"{"a":1}"#;
    let signed = sign_request(
        &signing_key,
        "test-key",
        "POST",
        "https://host.example/api/v1/tasks",
        body,
        chrono::Utc::now().timestamp(),
    );
    let replay = HttpSignedRequest {
        content_digest: content_digest_sha256(b"different body"),
        ..signed
    };
    assert!(validator.validate(&replay).is_err());
}

/// Sign with an arbitrary covered set, the way a permissive signer would.
fn sign_covering(
    signing_key: &SigningKey,
    covered: &[&str],
    body: &[u8],
    created: i64,
) -> HttpSignedRequest {
    let covered: Vec<String> = covered.iter().map(|c| (*c).to_string()).collect();
    let signature_input = format!(
        "sig=({});created={created};keyid=\"test-key\";alg=\"ed25519\"",
        covered
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let req = HttpSignedRequest {
        method: "POST".into(),
        target_uri: "https://host.example/api/v1/tasks".into(),
        content_digest: content_digest_sha256(body),
        signature_input: signature_input.clone(),
        signature: String::new(),
    };
    let base = build_signature_base(&covered, &req, &signature_input).unwrap();
    let sig = signing_key.sign(base.as_bytes());
    HttpSignedRequest {
        signature: format!("sig=:{}:", B64.encode(sig.to_bytes())),
        ..req
    }
}

#[test]
fn a_signature_that_covers_too_little_is_refused() {
    let (signing_key, validator) = fixture();
    let now = chrono::Utc::now().timestamp();

    // Each of these verifies arithmetically; none of them binds enough. Without
    // a required set, dropping content-digest leaves the body free to change
    // and dropping @target-uri lets the signature travel to another endpoint.
    for covered in [
        vec!["@method"],
        vec!["@method", "@target-uri"],
        vec!["content-digest"],
        vec!["content-digest", "@method"],
    ] {
        let signed = sign_covering(&signing_key, &covered, b"{}", now);
        let err = validator.validate(&signed).unwrap_err();
        assert!(
            matches!(&err, ProofError::InvalidProof(m) if m.contains("does not cover")),
            "{covered:?} -> {err:?}"
        );
    }

    // All three covered: accepted.
    let full = sign_covering(
        &signing_key,
        &["content-digest", "@method", "@target-uri"],
        b"{}",
        now,
    );
    assert!(validator.validate(&full).is_ok());
}

#[test]
fn a_future_dated_signature_is_refused() {
    let (signing_key, validator) = fixture();
    let signed = sign_request(
        &signing_key,
        "test-key",
        "POST",
        "https://host.example/api/v1/tasks",
        b"{}",
        chrono::Utc::now().timestamp() + 3_600,
    );
    let err = validator.validate(&signed).unwrap_err();
    assert!(
        matches!(&err, ProofError::InvalidProof(m) if m.contains("future")),
        "{err:?}"
    );
}

#[test]
fn profile_registered() {
    let profile = ProtocolProfile::parse_slug(PROFILE_HTTP_MESSAGE_SIGNATURES_RFC9421_V1).unwrap();
    assert_eq!(
        profile.minimum_presentation,
        TokenPresentation::HttpMessageSignature
    );
}
