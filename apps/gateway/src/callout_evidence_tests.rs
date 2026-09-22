use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::json;
use x509_parser::{prelude::FromDer, public_key::PublicKey, x509::SubjectPublicKeyInfo};

use super::*;

const ISSUER: &str = "https://idp.test";
const AUDIENCE: &str = "nats.opensesame.test";

struct Signer {
    jwks: String,
    key: EncodingKey,
}

/// An RSA key and the public JWKS for it, generated per test.
fn signer(kid: &str) -> Signer {
    let pair =
        opensesame_pki_core::keys::generate(opensesame_pki_core::KeyAlgorithm::Rsa2048).unwrap();
    let der = pair.public_key_der();
    let (_, spki) = SubjectPublicKeyInfo::from_der(&der).unwrap();
    let PublicKey::RSA(public) = spki.parsed().unwrap() else {
        panic!("RSA fixture");
    };
    let modulus = public.modulus.strip_prefix(&[0]).unwrap_or(public.modulus);
    let jwk = json!({"kty":"RSA","alg":"RS256","use":"sig","kid":kid,
        "n": URL_SAFE_NO_PAD.encode(modulus), "e": URL_SAFE_NO_PAD.encode(public.exponent)});
    Signer {
        jwks: json!({"keys":[jwk]}).to_string(),
        key: EncodingKey::from_rsa_pem(pair.private_key_pkcs8_pem().as_bytes()).unwrap(),
    }
}

fn verifier(signer: &Signer, audience: Option<&str>) -> CalloutEvidenceVerifier {
    let issuers = parse_issuer_jwks(&format!("{ISSUER}=https://idp.test/jwks"), false).unwrap();
    let verifier = CalloutEvidenceVerifier::new(issuers, audience.map(str::to_owned), false);
    verifier.preload(ISSUER, &signer.jwks).unwrap();
    verifier
}

fn token(signer: &Signer, kid: &str, claims: &serde_json::Value) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_owned());
    encode(&header, claims, &signer.key).unwrap()
}

fn claims(now: i64) -> serde_json::Value {
    json!({"iss": ISSUER, "sub": "user-1", "aud": AUDIENCE, "exp": now + 300, "iat": now})
}

#[tokio::test]
async fn a_valid_token_authenticates_an_issuer_and_subject() {
    let now = 1_800_000_000;
    let s = signer("k1");
    let v = verifier(&s, Some(AUDIENCE));
    let evidence = v.verify(&token(&s, "k1", &claims(now)), now).await.unwrap();
    assert_eq!(evidence.iss, ISSUER);
    assert_eq!(evidence.sub, "user-1");
    assert_eq!(evidence.email, None);
}

#[tokio::test]
async fn wrong_issuer_audience_expiry_signature_and_algorithm_all_deny() {
    let now = 1_800_000_000;
    let s = signer("k1");
    let v = verifier(&s, Some(AUDIENCE));

    // An issuer nobody configured never reaches key material.
    let mut other = claims(now);
    other["iss"] = json!("https://attacker.example");
    assert_eq!(
        v.verify(&token(&s, "k1", &other), now).await.unwrap_err(),
        EvidenceError::UnknownIssuer
    );

    // Wrong audience.
    let mut wrong_aud = claims(now);
    wrong_aud["aud"] = json!("someone-else");
    assert_eq!(
        v.verify(&token(&s, "k1", &wrong_aud), now)
            .await
            .unwrap_err(),
        EvidenceError::Invalid
    );

    // Signature-valid but expired.
    let mut expired = claims(now);
    expired["exp"] = json!(now - 1);
    assert_eq!(
        v.verify(&token(&s, "k1", &expired), now).await.unwrap_err(),
        EvidenceError::Invalid
    );

    // Signed by a different key.
    let attacker = signer("k1");
    assert_eq!(
        v.verify(&token(&attacker, "k1", &claims(now)), now)
            .await
            .unwrap_err(),
        EvidenceError::Invalid
    );

    // A key id nobody published.
    assert_eq!(
        v.verify(&token(&s, "k9", &claims(now)), now)
            .await
            .unwrap_err(),
        EvidenceError::Invalid
    );

    // Missing `sub`.
    let mut anonymous = claims(now);
    anonymous["sub"] = json!("");
    assert_eq!(
        v.verify(&token(&s, "k1", &anonymous), now)
            .await
            .unwrap_err(),
        EvidenceError::Invalid
    );
}

#[tokio::test]
async fn symmetric_and_unsigned_algorithms_are_refused_before_any_key_lookup() {
    let now = 1_800_000_000;
    let s = signer("k1");
    let v = verifier(&s, Some(AUDIENCE));
    let payload = URL_SAFE_NO_PAD.encode(claims(now).to_string());
    for header in [
        r#"{"alg":"none","typ":"JWT"}"#,
        r#"{"alg":"HS256","typ":"JWT","kid":"k1"}"#,
    ] {
        let forged = format!("{}.{payload}.c2ln", URL_SAFE_NO_PAD.encode(header));
        assert_eq!(
            v.verify(&forged, now).await.unwrap_err(),
            EvidenceError::Malformed,
            "{header}"
        );
    }
    assert_eq!(
        v.verify("", now).await.unwrap_err(),
        EvidenceError::Malformed
    );
    assert_eq!(
        v.verify(&"a".repeat(MAX_TOKEN_BYTES + 1), now)
            .await
            .unwrap_err(),
        EvidenceError::Malformed
    );
    assert_eq!(
        v.verify("not.a.jwt", now).await.unwrap_err(),
        EvidenceError::Malformed
    );
}

#[tokio::test]
async fn an_issuer_with_no_configuration_can_never_produce_an_identity() {
    let now = 1_800_000_000;
    let s = signer("k1");
    let empty = CalloutEvidenceVerifier::new(vec![], None, false);
    assert!(empty.is_empty());
    assert_eq!(
        empty
            .verify(&token(&s, "k1", &claims(now)), now)
            .await
            .unwrap_err(),
        EvidenceError::UnknownIssuer
    );
}

#[test]
fn jwks_endpoints_are_fenced() {
    // https everywhere; loopback http only outside production.
    assert!(parse_issuer_jwks("https://idp.test=https://idp.test/jwks", false).is_ok());
    assert!(parse_issuer_jwks("https://idp.test=http://idp.test/jwks", true).is_err());
    assert!(parse_issuer_jwks("https://idp.test=http://127.0.0.1:9090/jwks", false).is_err());
    assert!(parse_issuer_jwks("https://idp.test=http://127.0.0.1:9090/jwks", true).is_ok());
    // No credentials, no fragments, no trailing-dot hosts, no bare entries.
    assert!(parse_issuer_jwks("https://idp.test=https://u:p@idp.test/jwks", false).is_err());
    assert!(parse_issuer_jwks("https://idp.test=https://idp.test/jwks#x", false).is_err());
    assert!(parse_issuer_jwks("https://idp.test=https://idp.test./jwks", false).is_err());
    assert!(parse_issuer_jwks("no-equals-sign", false).is_err());
    assert!(parse_issuer_jwks("=https://idp.test/jwks", false).is_err());
    assert!(parse_issuer_jwks("", false).unwrap().is_empty());
}

#[test]
fn a_key_set_carrying_private_material_or_too_many_keys_is_refused() {
    let s = signer("k1");
    let v = CalloutEvidenceVerifier::new(vec![], None, false);
    assert!(v.preload(ISSUER, &s.jwks).is_ok());
    let mut set: serde_json::Value = serde_json::from_str(&s.jwks).unwrap();
    set["keys"][0]["d"] = json!("private");
    assert_eq!(
        v.preload(ISSUER, &set.to_string()).unwrap_err(),
        EvidenceError::Invalid
    );
    assert_eq!(
        v.preload(ISSUER, r#"{"keys":[]}"#).unwrap_err(),
        EvidenceError::Invalid
    );
    assert_eq!(
        v.preload(ISSUER, "not json").unwrap_err(),
        EvidenceError::Invalid
    );
    let one: serde_json::Value = serde_json::from_str(&s.jwks).unwrap();
    let many =
        json!({"keys": (0..MAX_KEYS + 1).map(|_| one["keys"][0].clone()).collect::<Vec<_>>()});
    assert_eq!(
        v.preload(ISSUER, &many.to_string()).unwrap_err(),
        EvidenceError::Invalid
    );
}

#[test]
fn every_failure_has_a_stable_code() {
    assert_eq!(EvidenceError::Missing.code(), "unsigned_evidence");
    assert_eq!(EvidenceError::UnknownIssuer.code(), "unknown_issuer");
    assert_eq!(EvidenceError::Malformed.code(), "malformed_evidence");
    assert_eq!(
        EvidenceError::IssuerUnreachable.code(),
        "issuer_unreachable"
    );
    assert_eq!(EvidenceError::Invalid.code(), "invalid_token");
}
