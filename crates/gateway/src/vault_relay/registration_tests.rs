use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde_json::json;
use tower::ServiceExt;
use x509_parser::{prelude::FromDer, public_key::PublicKey, x509::SubjectPublicKeyInfo};

use super::registration::Verifier;
use super::test_support::{key, snapshot};
use super::{router_with, Store, ORG_ROLE, OWNER_KIND, SLOT_KEY};

fn fixture_verifier() -> (Verifier, EncodingKey, i64) {
    let pair =
        opensesame_pki_core::keys::generate(opensesame_pki_core::KeyAlgorithm::Rsa2048).unwrap();
    let der = pair.public_key_der();
    let (_, spki) = SubjectPublicKeyInfo::from_der(&der).unwrap();
    let PublicKey::RSA(public) = spki.parsed().unwrap() else {
        panic!("RSA fixture");
    };
    let modulus = public.modulus.strip_prefix(&[0]).unwrap_or(public.modulus);
    let jwk = json!({
        "kty": "RSA",
        "alg": "RS256",
        "use": "sig",
        "kid": "relay-reg",
        "n": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(modulus),
        "e": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public.exponent),
    });
    let verifier = Verifier::new(
        "https://identity.example".into(),
        &json!({ "keys": [jwk] }).to_string(),
    )
    .unwrap();
    let signing = EncodingKey::from_rsa_pem(pair.private_key_pkcs8_pem().as_bytes()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).expect("test clock fits i64 seconds"))
        .unwrap_or(0);
    (verifier, signing, now)
}

fn registration_token(
    signing: &EncodingKey,
    now: i64,
    sub: &str,
    owner: &str,
    org_role: Option<&str>,
) -> String {
    let claims = json!({
        "iss": "https://identity.example",
        "aud": "vault-relay",
        "sub": sub,
        "exp": now + 120,
        "org_role": org_role,
        "owner": owner,
    });
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.typ = Some("vault-relay-registration+jwt".into());
    header.kid = Some("relay-reg".into());
    encode(&header, &claims, signing).unwrap()
}

async fn put_with_auth(
    app: axum::Router,
    slug: &str,
    slot_key: &str,
    token: Option<&str>,
    forged_role: Option<&str>,
) -> StatusCode {
    let mut builder = Request::builder()
        .method("PUT")
        .uri(format!("/v1/vault-relay/acme/{slug}/snapshot"))
        .header(SLOT_KEY, slot_key)
        .header(OWNER_KIND, "organization")
        .header("content-type", "application/json");
    if let Some(role) = forged_role {
        builder = builder.header(ORG_ROLE, role);
    }
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = builder
        .body(Body::from(
            json!({ "expected_generation": 0, "snapshot": snapshot("prj_ledger") }).to_string(),
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    response.status()
}

#[tokio::test]
async fn registration_jwt_governs_publish_and_refuses_forged_role_headers() {
    let (verifier, signing, now) = fixture_verifier();
    let bindings = super::install_relay_bindings(None).unwrap();
    let member_token = registration_token(&signing, now, "ada", "acme", Some("member"));
    let owner_token = registration_token(&signing, now, "ada", "acme", Some("owner"));

    let app = router_with(
        Arc::new(Mutex::new(Store::default())),
        bindings.clone(),
        None,
        Some(verifier.clone()),
    );
    assert_eq!(
        put_with_auth(app, "ledger", &key(), None, None).await,
        StatusCode::UNAUTHORIZED
    );

    let app = router_with(
        Arc::new(Mutex::new(Store::default())),
        bindings.clone(),
        None,
        Some(verifier.clone()),
    );
    assert_eq!(
        put_with_auth(app, "ledger", &key(), Some(&member_token), Some("owner")).await,
        StatusCode::FORBIDDEN
    );

    let app = router_with(
        Arc::new(Mutex::new(Store::default())),
        bindings,
        None,
        Some(verifier),
    );
    assert_eq!(
        put_with_auth(app, "books", &key(), Some(&owner_token), None).await,
        StatusCode::OK
    );
}
