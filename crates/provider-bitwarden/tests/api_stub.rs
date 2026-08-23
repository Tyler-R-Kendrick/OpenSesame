//! API-layer tests against a loopback `hyper` stub serving the recorded
//! fixtures. No network (C9): the stub binds `127.0.0.1:0` and the client is
//! pointed at it explicitly.
//!
//! Both real topologies are driven end to end:
//! * **vaultwarden** — one origin, `/identity` + `/api`, Argon2id, user key
//!   only on the sync profile;
//! * **bitwarden.com** — two *separate* servers (identity and api), PascalCase
//!   payloads, PBKDF2, user key on the token response.

mod common;

use std::collections::BTreeMap;

use common::{
    cloud_api_routes, cloud_identity_routes, spawn_stub, vaultwarden_routes, Hit, Shape, COSE_ID,
};
use opensesame_provider_bitwarden::{BitwardenClient, Config, Endpoints, Error};
use secrecy::SecretString;

fn password(shape: Shape) -> SecretString {
    SecretString::from(shape.master_password().to_owned())
}

fn form_value(body: &str, key: &str) -> Option<String> {
    body.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| percent_decode(value))
    })
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                i += 3;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn paths(hits: &[Hit]) -> Vec<String> {
    hits.iter()
        .map(|hit| format!("{} {}", hit.method, hit.path))
        .collect()
}

#[tokio::test]
async fn vaultwarden_topology_is_driven_end_to_end() {
    let shape = Shape::Vaultwarden;
    let (base, hits) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let vault = client.vault().await.expect("vault");

    let hits = hits.lock().unwrap().clone();
    assert_eq!(
        paths(&hits),
        vec![
            "POST /identity/accounts/prelogin",
            "POST /identity/connect/token",
            // This fixture omits the token key, so the profile key path runs
            // — and the sync payload it fetched is reused, not re-fetched.
            "GET /api/sync",
        ]
    );
    assert_eq!(
        hits[2].authorization.as_deref(),
        Some(format!("Bearer {}", shape.access_token()).as_str())
    );
    assert_eq!(hits[2].query.as_deref(), Some("excludeDomains=true"));

    insta::assert_json_snapshot!("vaultwarden_vault", vault);
}

#[tokio::test]
async fn cloud_topology_uses_separate_identity_and_api_hosts() {
    let shape = Shape::Cloud;
    let (identity, identity_hits) = spawn_stub(cloud_identity_routes()).await;
    let (api, api_hits) = spawn_stub(cloud_api_routes()).await;
    let config = Config::from_split_urls(&api, &identity).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let vault = client.vault().await.expect("vault");

    assert_eq!(
        paths(&identity_hits.lock().unwrap()),
        vec!["POST /accounts/prelogin", "POST /connect/token"],
        "identity host must see only identity traffic"
    );
    assert_eq!(
        paths(&api_hits.lock().unwrap()),
        vec!["GET /sync"],
        "api host must see only api traffic"
    );

    insta::assert_json_snapshot!("cloud_vault", vault);
}

#[tokio::test]
async fn the_server_only_ever_sees_the_master_password_hash() {
    let shape = Shape::Cloud;
    let (identity, hits) = spawn_stub(cloud_identity_routes()).await;
    let (api, _) = spawn_stub(cloud_api_routes()).await;
    let config = Config::from_split_urls(&api, &identity).unwrap();
    BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");

    let hits = hits.lock().unwrap().clone();
    let prelogin = &hits[0];
    let token = &hits[1];

    // The email is normalized before it leaves the client — a capitalized
    // address must not derive a different key than the same address typed in
    // lower case.
    assert!(
        prelogin.body.contains("cloud-user@example.com"),
        "{}",
        prelogin.body
    );
    assert!(!prelogin.body.contains("Cloud-User"), "{}", prelogin.body);

    let sent = form_value(&token.body, "password").expect("password field");
    let expected = shape
        .master_key()
        .password_hash_b64(shape.master_password().as_bytes());
    assert_eq!(sent, expected, "the wire value must be the master password hash");
    for body in [&prelogin.body, &token.body] {
        assert!(
            !body.contains(shape.master_password()),
            "the master password itself must never reach the wire: {body}"
        );
        assert!(!body.contains("correct+horse"), "form-encoded leak: {body}");
    }
    assert_eq!(form_value(&token.body, "grant_type").as_deref(), Some("password"));
    assert_eq!(form_value(&token.body, "scope").as_deref(), Some("api offline_access"));
    assert!(form_value(&token.body, "deviceIdentifier").is_some());
    assert!(form_value(&token.body, "deviceType").is_some());
}

#[tokio::test]
async fn a_redirect_is_a_response_never_a_chase() {
    let mut routes = vaultwarden_routes();
    routes.insert(
        "/identity/accounts/prelogin".to_owned(),
        (302, r#"{"moved":true}"#.to_owned()),
    );
    let (base, hits) = spawn_stub(routes).await;
    let config = Config::from_server_url(&base).unwrap();
    let error = BitwardenClient::unlock(
        config,
        Shape::Vaultwarden.email(),
        &password(Shape::Vaultwarden),
    )
    .await
    .expect_err("a 3xx must not be followed");
    assert_eq!(error.code(), "redirect_refused");
    assert!(matches!(error, Error::RedirectRefused { status: 302, .. }));
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "the redirect target was chased"
    );
}

#[tokio::test]
async fn an_invalid_grant_is_a_named_authentication_error() {
    let mut routes = vaultwarden_routes();
    routes.insert(
        "/identity/connect/token".to_owned(),
        (
            400,
            r#"{"error":"invalid_grant","error_description":"Username or password is incorrect. Try again."}"#
                .to_owned(),
        ),
    );
    let (base, _) = spawn_stub(routes).await;
    let config = Config::from_server_url(&base).unwrap();
    let error = BitwardenClient::unlock(
        config,
        Shape::Vaultwarden.email(),
        &password(Shape::Vaultwarden),
    )
    .await
    .expect_err("wrong password");
    assert_eq!(error.code(), "authentication");
    assert!(error.to_string().contains("incorrect"), "{error}");
}

#[tokio::test]
async fn a_two_factor_challenge_is_named_not_reported_as_http_400() {
    let mut routes = vaultwarden_routes();
    routes.insert(
        "/identity/connect/token".to_owned(),
        (
            400,
            r#"{"error":"invalid_grant","TwoFactorProviders":["0"],"TwoFactorProviders2":{"0":null}}"#
                .to_owned(),
        ),
    );
    let (base, _) = spawn_stub(routes).await;
    let config = Config::from_server_url(&base).unwrap();
    let error = BitwardenClient::unlock(
        config,
        Shape::Vaultwarden.email(),
        &password(Shape::Vaultwarden),
    )
    .await
    .expect_err("2FA");
    assert_eq!(error.code(), "two_factor_required");
    assert!(error.to_string().contains("bw"), "{error}");
}

#[tokio::test]
async fn read_returns_a_password_and_list_stays_secret_free() {
    let shape = Shape::Vaultwarden;
    let (base, _) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");

    assert_eq!(&*client.read("Work/GitHub").await.unwrap(), "s3cr3t-github-password");
    assert_eq!(&*client.read("Router").await.unwrap(), "admin-password");
    assert_eq!(
        &*client.read(common::LOGIN_ID).await.unwrap(),
        "s3cr3t-github-password"
    );

    let listing = client.list().await.unwrap();
    assert!(listing.contains("GitHub"), "{listing}");
    assert!(listing.contains("octocat"), "{listing}");
    assert!(
        !listing.contains("s3cr3t-github-password"),
        "listings must never carry a password: {listing}"
    );
    assert!(!listing.contains("4815"), "hidden fields must not leak: {listing}");
    insta::assert_snapshot!("vaultwarden_listing", listing);
}

#[tokio::test]
async fn a_cose_item_is_named_rather_than_silently_dropped() {
    let shape = Shape::Vaultwarden;
    let (base, _) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let vault = client.vault().await.unwrap();

    let unreadable = vault
        .unreadable
        .iter()
        .find(|item| item.id == COSE_ID)
        .expect("the type-7 item is recorded, not dropped");
    assert_eq!(unreadable.code, "cose_encrypt_unsupported");
    assert_eq!(unreadable.name.as_deref(), Some("Migrated to COSE"));

    // Asking for it by name or id surfaces the same named error.
    for resource in [COSE_ID, "Migrated to COSE"] {
        let error = vault.password(resource).expect_err("type 7 is refused");
        assert_eq!(error.code(), "cose_encrypt_unsupported", "for {resource}");
    }
    // …and one COSE item does not poison the rest of the vault.
    assert_eq!(vault.items.len(), 3);
}

#[tokio::test]
async fn trashed_and_organization_items_are_counted_not_guessed_at() {
    let shape = Shape::Vaultwarden;
    let (base, _) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let vault = client.vault().await.unwrap();
    assert_eq!(vault.skipped_deleted, 1);
    assert_eq!(vault.skipped_organization, 1);
    assert_eq!(vault.password("Old thing").unwrap_err().code(), "item_not_found");
    assert_eq!(
        vault.password("Shared deploy key").unwrap_err().code(),
        "item_not_found"
    );
}

#[tokio::test]
async fn missing_items_and_passwordless_items_are_distinguished() {
    let shape = Shape::Vaultwarden;
    let (base, _) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let mut client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let vault = client.vault().await.unwrap();
    assert_eq!(vault.password("nope").unwrap_err().code(), "item_not_found");
    assert_eq!(
        vault.password("Work/Door code").unwrap_err().code(),
        "no_password",
        "a secure note has no login password"
    );
}

#[tokio::test]
async fn the_server_config_endpoint_is_reachable_without_a_session() {
    let shape = Shape::Vaultwarden;
    let (base, hits) = spawn_stub(vaultwarden_routes()).await;
    let config = Config::from_server_url(&base).unwrap();
    let client = BitwardenClient::unlock(config, shape.email(), &password(shape))
        .await
        .expect("unlock");
    let server = client.server_config().await.expect("config");
    assert_eq!(server.version.as_deref(), Some("1.35.0"));
    assert!(paths(&hits.lock().unwrap()).contains(&"GET /api/config".to_owned()));
}

#[tokio::test]
async fn a_missing_route_is_an_api_error_not_a_panic() {
    let (base, _) = spawn_stub(BTreeMap::new()).await;
    let config = Config::from_server_url(&base).unwrap();
    let error = BitwardenClient::unlock(
        config,
        Shape::Vaultwarden.email(),
        &password(Shape::Vaultwarden),
    )
    .await
    .expect_err("no routes");
    assert_eq!(error.code(), "api");
}

#[tokio::test]
async fn a_truncated_body_is_a_named_malformed_response() {
    let mut routes = vaultwarden_routes();
    routes.insert(
        "/identity/accounts/prelogin".to_owned(),
        (200, "{\"kdf\":".to_owned()),
    );
    let (base, _) = spawn_stub(routes).await;
    let config = Config::from_server_url(&base).unwrap();
    let error = BitwardenClient::unlock(
        config,
        Shape::Vaultwarden.email(),
        &password(Shape::Vaultwarden),
    )
    .await
    .expect_err("truncated JSON");
    assert_eq!(error.code(), "malformed_response");
}

#[test]
fn cloud_server_urls_expand_to_the_split_hosts() {
    for raw in [
        "https://vault.bitwarden.com",
        "https://bitwarden.com",
        "https://vault.bitwarden.com/",
    ] {
        let endpoints = Endpoints::from_server_url(raw).unwrap();
        assert_eq!(endpoints.api_base().as_str(), "https://api.bitwarden.com/");
        assert_eq!(
            endpoints.identity_base().as_str(),
            "https://identity.bitwarden.com/"
        );
    }
    let eu = Endpoints::from_server_url("https://vault.bitwarden.eu").unwrap();
    assert_eq!(eu.api_base().as_str(), "https://api.bitwarden.eu/");
    assert_eq!(eu.identity_base().as_str(), "https://identity.bitwarden.eu/");
}

#[test]
fn self_hosted_server_urls_mount_api_and_identity_under_the_origin() {
    let endpoints = Endpoints::from_server_url("https://vault.example.com/").unwrap();
    assert_eq!(endpoints.api_base().as_str(), "https://vault.example.com/api");
    assert_eq!(
        endpoints.identity_base().as_str(),
        "https://vault.example.com/identity"
    );
    assert_eq!(endpoints.pinned_hosts(), vec!["vault.example.com".to_owned()]);
}

#[test]
fn only_https_or_loopback_http_is_accepted() {
    for raw in [
        "http://vault.example.com",
        "ftp://vault.example.com",
        "https://user:pass@vault.example.com",
        "not a url",
        "https://",
        "file:///etc/passwd",
    ] {
        let error = Endpoints::from_server_url(raw)
            .err()
            .unwrap_or_else(|| panic!("`{raw}` must be rejected"));
        assert_eq!(error.code(), "invalid_server_url", "for {raw}");
    }
    assert!(Endpoints::from_server_url("http://127.0.0.1:8080").is_ok());
    assert!(Endpoints::from_server_url("http://localhost:8080").is_ok());
    assert!(Endpoints::from_server_url("https://vault.example.com").is_ok());
}
