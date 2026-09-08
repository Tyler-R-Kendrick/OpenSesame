use opensesame_proof::{decode_dpop_proof, DpopValidator, InMemoryReplayCache};

// The independent signer uses browser WebCrypto, not the Rust validator's crypto.
// A fresh non-extractable private key exists only in the child process.
fn browser_proof() -> String {
    let output = std::process::Command::new("node")
        .env_remove("NODE_OPTIONS")
        .args(["--input-type=module", "-e"])
        .arg(include_str!("browser_es256_fixture.mjs"))
        .output()
        .expect("Node 22 or newer is required for the WebCrypto interoperability oracle");
    assert!(
        output.status.success(),
        "WebCrypto fixture generation failed"
    );
    assert!(
        output.stdout.len() <= 4096,
        "WebCrypto fixture exceeded its bound"
    );
    String::from_utf8(output.stdout).unwrap_or_else(|_| panic!("WebCrypto fixture was not UTF-8"))
}

const URI: &str = "https://host.example/api/v1/browser-pairings";

#[test]
fn request_target_normalization_preserves_ipv6_and_refuses_userinfo() {
    assert_eq!(
        opensesame_proof::normalize_htu("http://[::1]:8787/api?q=1").unwrap(),
        "http://[::1]:8787/api"
    );
    assert!(opensesame_proof::normalize_htu("http://user:secret@localhost/api").is_err());
    assert!(opensesame_proof::normalize_htu("file:///api").is_err());
}

#[test]
fn private_jwk_members_are_refused_before_signature_processing() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let header = URL_SAFE_NO_PAD
        .encode(br#"{"typ":"dpop+jwt","alg":"ES256","jwk":{"kty":"EC","d":"private-sentinel"}}"#);
    let error = decode_dpop_proof(
        &format!("{header}.e30.invalid"),
        "POST",
        URI,
        None,
        300,
        1_700_000_000,
    )
    .unwrap_err();
    assert!(error.to_string().contains("public proof key required"));
    assert!(!error.to_string().contains("private-sentinel"));
}

#[test]
fn ignored_critical_or_remote_key_headers_are_refused() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    for extra in [
        serde_json::json!({"crit":["b64"]}),
        serde_json::json!({"b64":false}),
        serde_json::json!({"jku":"https://attacker.example/keys"}),
        serde_json::json!({"x5u":"https://attacker.example/cert"}),
    ] {
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&extra).unwrap());
        let error = decode_dpop_proof(
            &format!("{header}.e30.invalid"),
            "POST",
            URI,
            None,
            300,
            1_700_000_000,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported proof header parameter"));
        assert!(!error.to_string().contains("attacker.example"));
    }
}

#[test]
fn duplicate_security_header_fields_are_not_last_writer_wins() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"dpop+jwt","alg":"none","alg":"ES256"}"#);
    let error = decode_dpop_proof(
        &format!("{header}.e30.invalid"),
        "POST",
        URI,
        None,
        300,
        1_700_000_000,
    )
    .unwrap_err();
    assert!(error.to_string().contains("malformed header"));
}

#[test]
fn browser_es256_proof_validates_once_and_is_bound_to_method_and_target() {
    let proof = browser_proof();
    let validator = DpopValidator::new(InMemoryReplayCache::new(), 300);
    let valid = validator
        .validate(Some(&proof), "POST", URI, 1_700_000_000, None, None)
        .unwrap();
    assert_eq!(valid.jkt.len(), 43);
    assert!(validator
        .validate(Some(&proof), "POST", URI, 1_700_000_000, None, None)
        .is_err());
    assert!(decode_dpop_proof(&proof, "post", URI, None, 300, 1_700_000_000).is_err());
    assert!(decode_dpop_proof(
        &proof,
        "POST",
        "https://other.example/",
        None,
        300,
        1_700_000_000
    )
    .is_err());
    assert!(decode_dpop_proof(&proof, "POST", URI, None, 300, i64::MAX).is_err());
    assert!(decode_dpop_proof(&proof, "POST", URI, None, 300, i64::MIN).is_err());
}
