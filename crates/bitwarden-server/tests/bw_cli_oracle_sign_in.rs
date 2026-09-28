//! Sign-in methods under the oracle (ADR 0148): the official `bw` answers a
//! two-step challenge with an authenticator code, and signs in with a
//! personal API key and then unlocks with the master password.
//!
//! `#[ignore]`d like the other oracle suites; `pnpm test:bitwarden-oracle` runs
//! it with the pinned CLI and fails, never skips, without it.
mod common;

use common::bw::Bw;
use common::client::{http, Account, ARGON2ID};
use common::Harness;
use opensesame_authenticator_core::{parse_otpauth, totp_code};
use serde_json::{json, Value};

const PASSWORD: &str = "correct horse battery staple";

fn code(key: &str, offset: i64) -> String {
    let uri = parse_otpauth(&format!("otpauth://totp/t?secret={key}")).unwrap();
    let at = chrono::Utc::now().timestamp() + offset * 30;
    totp_code(&uri, u64::try_from(at).unwrap()).unwrap()
}

async fn call(
    method: reqwest::Method,
    harness: &Harness,
    path: &str,
    token: &str,
    body: &Value,
) -> Value {
    let response = http()
        .request(method, format!("{}{path}", harness.http_url))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{path}: {}",
        response.status()
    );
    response.json().await.unwrap()
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_answers_an_authenticator_challenge() {
    let harness = Harness::start().await;
    let person =
        Account::register(&harness.http_url, "twostep@example.com", PASSWORD, ARGON2ID).await;
    let access = person.access_token(&harness.http_url).await;
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let issued = call(
        reqwest::Method::POST,
        &harness,
        "/api/two-factor/get-authenticator",
        &access,
        &proof,
    )
    .await;
    let key = issued["key"].as_str().unwrap().to_owned();
    let enable =
        json!({"key": key, "token": code(&key, 0), "masterPasswordHash": person.password_hash()});
    call(
        reqwest::Method::PUT,
        &harness,
        "/api/two-factor/authenticator",
        &access,
        &enable,
    )
    .await;

    let mut bw = Bw::new(&harness).await;
    // Without a code, bw asks for one (non-interactively: it says so).
    let refused = bw.fails(&["login", "twostep@example.com", PASSWORD]).await;
    assert!(refused.contains("Code is required"), "{refused}");
    // A wrong code is refused.
    bw.fails(&[
        "login",
        "twostep@example.com",
        PASSWORD,
        "--method",
        "0",
        "--code",
        "000000",
    ])
    .await;
    let next = code(&key, 1);
    let session = bw
        .ok(&[
            "login",
            "twostep@example.com",
            PASSWORD,
            "--method",
            "0",
            "--code",
            &next,
            "--raw",
        ])
        .await;
    assert!(!session.is_empty());
    bw.session = Some(session);
    assert_eq!(bw.json(&["status"]).await["status"], "unlocked");
    assert!(harness.unrouted().is_empty(), "{:?}", harness.unrouted());
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_signs_in_with_an_api_key_and_unlocks_with_the_password() {
    let harness = Harness::start().await;
    let person =
        Account::register(&harness.http_url, "apikey@example.com", PASSWORD, ARGON2ID).await;
    let access = person.access_token(&harness.http_url).await;
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let key = call(
        reqwest::Method::POST,
        &harness,
        "/api/accounts/api-key",
        &access,
        &proof,
    )
    .await["apiKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = harness
        .db
        .bitwarden_user_by_email(&person.email)
        .await
        .unwrap()
        .unwrap()
        .id;
    let client_id = format!("user.{id}");

    let mut bw = Bw::new(&harness).await;
    let output = bw
        .run_env(
            &["login", "--apikey"],
            &[("BW_CLIENTID", &client_id), ("BW_CLIENTSECRET", &key)],
        )
        .await;
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(bw.json(&["status"]).await["status"], "locked");
    let session = bw.ok(&["unlock", PASSWORD, "--raw"]).await;
    bw.session = Some(session);
    bw.create("folder", &json!({"name": "Scripts"})).await;
    assert_eq!(bw.json(&["list", "folders"]).await[0]["name"], "Scripts");
    assert!(harness.unrouted().is_empty(), "{:?}", harness.unrouted());
}
