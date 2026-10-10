//! Registration and directory attacks against the relay profile.
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use tower::ServiceExt;
use x509_parser::{prelude::FromDer, public_key::PublicKey, x509::SubjectPublicKeyInfo};

use super::registration::Verifier;
use super::test_support::{key, snapshot};
use super::{router_with, Store, ORG_ROLE, OWNER_KIND, PRINCIPAL, SLOT_KEY};

const ISS: &str = "https://identity.example";
const AUD: &str = "vault-relay";
const TYP: &str = "vault-relay-registration+jwt";
const KID: &str = "relay-reg";

struct Fixture {
    verifier: Verifier,
    signing: EncodingKey,
    modulus: Vec<u8>,
    now: i64,
}

fn fixture() -> Fixture {
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
        "kid": KID,
        "n": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(modulus),
        "e": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public.exponent),
    });
    let verifier = Verifier::new(ISS.into(), &json!({ "keys": [jwk] }).to_string()).unwrap();
    let signing = EncodingKey::from_rsa_pem(pair.private_key_pkcs8_pem().as_bytes()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).expect("test clock fits i64 seconds"))
        .unwrap_or(0);
    Fixture {
        verifier,
        signing,
        modulus: modulus.to_vec(),
        now,
    }
}

fn token(signing: &EncodingKey, claims: &Value, kid: &str, alg: Algorithm) -> String {
    let mut header = Header::new(alg);
    header.typ = Some(TYP.into());
    header.kid = Some(kid.into());
    encode(&header, claims, signing).unwrap()
}

fn claims(now: i64, sub: &str, owner: &str, role: &str) -> Value {
    json!({
        "iss": ISS,
        "aud": AUD,
        "sub": sub,
        "exp": now + 120,
        "org_role": role,
        "owner": owner,
    })
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn app(verifier: Verifier) -> axum::Router {
    router_with(
        Arc::new(Mutex::new(Store::default())),
        super::install_relay_bindings(None).unwrap(),
        None,
        Some(verifier),
    )
}

async fn status_of(request: Request<Body>, router: axum::Router) -> StatusCode {
    router.oneshot(request).await.unwrap().status()
}

fn put(path: &str, slot: &str, token: Option<&str>, forged_role: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("PUT")
        .uri(path)
        .header(SLOT_KEY, slot)
        .header(OWNER_KIND, "organization")
        .header("content-type", "application/json");
    if let Some(role) = forged_role {
        builder = builder.header(ORG_ROLE, role);
    }
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder
        .body(Body::from(
            json!({ "expected_generation": 0, "snapshot": snapshot("prj_ledger") }).to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn alg_none_registration_is_refused() {
    let fixture = fixture();
    let header = b64(format!(r#"{{"alg":"none","typ":"{TYP}","kid":"{KID}"}}"#).as_bytes());
    let payload = b64(claims(fixture.now, "ada", "acme", "owner")
        .to_string()
        .as_bytes());
    let forged = format!("{header}.{payload}.");
    let status = status_of(
        put(
            "/v1/vault-relay/acme/ledger/snapshot",
            &key(),
            Some(&forged),
            None,
        ),
        app(fixture.verifier),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn hs256_with_the_rsa_modulus_and_a_foreign_rs256_key_are_refused() {
    let fixture = fixture();
    let body = claims(fixture.now, "ada", "acme", "owner");
    let hmac = EncodingKey::from_secret(&fixture.modulus);
    let confused = token(&hmac, &body, KID, Algorithm::HS256);
    let other =
        opensesame_pki_core::keys::generate(opensesame_pki_core::KeyAlgorithm::Rsa2048).unwrap();
    let foreign_key = EncodingKey::from_rsa_pem(other.private_key_pkcs8_pem().as_bytes()).unwrap();
    let foreign = token(&foreign_key, &body, KID, Algorithm::RS256);
    for forged in [confused, foreign] {
        let status = status_of(
            put(
                "/v1/vault-relay/acme/ledger/snapshot",
                &key(),
                Some(&forged),
                None,
            ),
            app(fixture.verifier.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn wrong_issuer_audience_kid_and_clock_are_refused() {
    let fixture = fixture();
    let cases = [
        claims(fixture.now, "ada", "acme", "owner"),
        {
            let mut wrong_iss = claims(fixture.now, "ada", "acme", "owner");
            wrong_iss["iss"] = json!("https://evil.example");
            wrong_iss
        },
        {
            let mut wrong_aud = claims(fixture.now, "ada", "acme", "owner");
            wrong_aud["aud"] = json!("host-api");
            wrong_aud
        },
        {
            let mut expired = claims(fixture.now, "ada", "acme", "owner");
            expired["exp"] = json!(fixture.now - 30);
            expired
        },
        {
            let mut early = claims(fixture.now, "ada", "acme", "owner");
            early["nbf"] = json!(fixture.now + 60);
            early
        },
    ];
    let kids = [KID, KID, KID, KID, KID];
    let mut tokens = Vec::new();
    for (index, body) in cases.iter().enumerate().skip(1) {
        tokens.push(token(&fixture.signing, body, kids[index], Algorithm::RS256));
    }
    let unknown_kid = token(&fixture.signing, &cases[0], "not-in-jwks", Algorithm::RS256);
    tokens.push(unknown_kid);
    for forged in tokens {
        let status = status_of(
            put(
                "/v1/vault-relay/acme/ledger/snapshot",
                &key(),
                Some(&forged),
                None,
            ),
            app(fixture.verifier.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn tampered_role_claim_is_refused() {
    let fixture = fixture();
    let signed = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "acme", "member"),
        KID,
        Algorithm::RS256,
    );
    let mut parts = signed.split('.');
    let header = parts.next().unwrap();
    let payload = parts.next().unwrap();
    let signature = parts.next().unwrap();
    let mut body: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap(),
    )
    .unwrap();
    body["org_role"] = json!("owner");
    let forged = format!("{header}.{}.{signature}", b64(body.to_string().as_bytes()));
    let status = status_of(
        put(
            "/v1/vault-relay/acme/ledger/snapshot",
            &key(),
            Some(&forged),
            None,
        ),
        app(fixture.verifier),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn forged_role_header_does_not_override_a_member_jwt() {
    let fixture = fixture();
    let member = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "acme", "member"),
        KID,
        Algorithm::RS256,
    );
    let status = status_of(
        put(
            "/v1/vault-relay/acme/ledger/snapshot",
            &key(),
            Some(&member),
            Some("owner"),
        ),
        app(fixture.verifier),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn member_cannot_publish_and_owner_token_cannot_cross_orgs() {
    let fixture = fixture();
    let member = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "acme", "member"),
        KID,
        Algorithm::RS256,
    );
    let owner = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "acme", "owner"),
        KID,
        Algorithm::RS256,
    );
    assert_eq!(
        status_of(
            put(
                "/v1/vault-relay/acme/ledger/snapshot",
                &key(),
                Some(&member),
                None,
            ),
            app(fixture.verifier.clone()),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status_of(
            put(
                "/v1/vault-relay/beta/secret/snapshot",
                &key(),
                Some(&owner),
                None,
            ),
            app(fixture.verifier.clone()),
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status_of(
            put(
                "/v1/vault-relay/acme/ledger/snapshot",
                &key(),
                Some(&owner),
                Some("member"),
            ),
            app(fixture.verifier),
        )
        .await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn org_directory_refuses_cross_org_reads_and_creates() {
    let fixture = fixture();
    let store = Arc::new(Mutex::new(Store::default()));
    let bindings = super::install_relay_bindings(None).unwrap();
    let acme = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "acme", "owner"),
        KID,
        Algorithm::RS256,
    );
    let beta = token(
        &fixture.signing,
        &claims(fixture.now, "ada", "beta", "owner"),
        KID,
        Algorithm::RS256,
    );
    let router = || {
        router_with(
            Arc::clone(&store),
            bindings.clone(),
            None,
            Some(fixture.verifier.clone()),
        )
    };
    let create = |token: &str, owner: &str, slug: &str| {
        Request::builder()
            .method("POST")
            .uri("/v1/org-vaults")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "ownerKind": "organization", "owner": owner, "slug": slug }).to_string(),
            ))
            .unwrap()
    };
    assert_eq!(
        status_of(create(&acme, "acme", "ledger"), router()).await,
        StatusCode::CREATED
    );
    assert_eq!(
        status_of(create(&beta, "beta", "secret"), router()).await,
        StatusCode::CREATED
    );
    assert_eq!(
        status_of(create(&acme, "beta", "stolen"), router()).await,
        StatusCode::FORBIDDEN
    );
    let list = Request::builder()
        .method("GET")
        .uri("/v1/org-vaults?owner=beta")
        .header("authorization", format!("Bearer {acme}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(status_of(list, router()).await, StatusCode::FORBIDDEN);
    let listed = router()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/org-vaults?principal=ada")
                .header("authorization", format!("Bearer {acme}"))
                .header(PRINCIPAL, "mallory")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(listed.into_body(), 64 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        body["vaults"],
        json!([{ "ownerKind": "organization", "owner": "acme", "slug": "ledger" }])
    );
}
