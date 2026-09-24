use super::*;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::json;
use x509_parser::{prelude::FromDer, public_key::PublicKey, x509::SubjectPublicKeyInfo};

#[test]
fn only_pinned_fresh_phishing_resistant_purpose_evidence_is_accepted() {
    let pair =
        opensesame_pki_core::keys::generate(opensesame_pki_core::KeyAlgorithm::Rsa2048).unwrap();
    let der = pair.public_key_der();
    let (_, spki) = SubjectPublicKeyInfo::from_der(&der).unwrap();
    let PublicKey::RSA(public) = spki.parsed().unwrap() else {
        panic!("RSA fixture");
    };
    let modulus = public.modulus.strip_prefix(&[0]).unwrap_or(public.modulus);
    let key = json!({"kty":"RSA","alg":"RS256","use":"sig","kid":"test",
        "n":URL_SAFE_NO_PAD.encode(modulus),"e":URL_SAFE_NO_PAD.encode(public.exponent)});
    let verifier = HostAuthorizationVerifier::new(
        "https://identity.example".into(),
        &json!({"keys":[key.clone()]}).to_string(),
    )
    .unwrap();
    let signing = EncodingKey::from_rsa_pem(pair.private_key_pkcs8_pem().as_bytes()).unwrap();
    let now = 1_800_000_000;
    let claims = json!({"iss":"https://identity.example","aud":"https://host.example","host_audience":"https://host.example",
        "sub":crate::test_principals::P11,"organization_id":opensesame_domain::OrganizationId::new().to_string(),"organization_role":"member",
        "challenge_id":"challenge","challenge_digest":"a".repeat(64),"operation":"agent.browser.control","target_id":"run",
        "transition":"take","origin":"https://paired.example","dpop_jkt":"a".repeat(43),"auth_time":now,"amr":["webauthn"],
        "assurance":"phishing_resistant","iat":now,"exp":now+120,"expires_at":now+120,"jti":uuid::Uuid::new_v4().to_string()});
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("host-authorization+jwt".into());
    header.kid = Some("test".into());
    let token = encode(&header, &claims, &signing).unwrap();
    assert!(verifier.verify(&token, "https://host.example", now).is_ok());
    assert!(verifier
        .verify(&token, "https://other-host.example", now)
        .is_err());
    for (field, value) in [
        ("iss", json!("https://attacker.example")),
        ("aud", json!("https://attacker.example")),
        ("auth_time", json!(now - 301)),
        ("auth_time", json!(now + 1)),
        ("iat", json!(now + 1)),
        ("exp", json!(now - 1)),
        ("exp", json!(now + 301)),
        ("amr", json!(["totp"])),
        ("assurance", json!("mfa")),
        ("sub", json!("user:demo")),
        ("organization_role", json!("unknown")),
        ("jti", json!("")),
        ("nbf", json!(now + 1)),
    ] {
        let mut changed = claims.clone();
        changed[field] = value;
        let token = encode(&header, &changed, &signing).unwrap();
        assert!(
            verifier
                .verify(&token, "https://host.example", now)
                .is_err(),
            "{field}"
        );
    }
    for typ in ["JWT", "dpop+jwt", "sia+jwt"] {
        header.typ = Some(typ.into());
        assert!(verifier
            .verify(
                &encode(&header, &claims, &signing).unwrap(),
                "https://host.example",
                now
            )
            .is_err());
    }
    assert!(HostAuthorizationVerifier::new(
        "https://identity.example".into(),
        &json!({"keys":[key.clone(),key]}).to_string()
    )
    .is_err());
    assert!(HostAuthorizationVerifier::new("http://identity.example".into(), "{}").is_err());
    assert!(verifier
        .verify("e30.e30.invalid", "https://host.example", now)
        .is_err());
}
