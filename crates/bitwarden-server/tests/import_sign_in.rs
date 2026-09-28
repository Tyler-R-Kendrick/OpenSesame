//! Sign-in methods move with an account (ADR 0148): its API key, its
//! authenticator and its recovery code, from a vaultwarden database and from
//! a live account, so nobody sets two-step login up again after a move.
mod common;

use common::client::{http, Account};
use common::vaultwarden::{
    enable_two_step, fixture, API_KEY, AUTHENTICATOR_KEY, EMAIL, PASSWORD, RECOVERY,
};
use common::Harness;
use opensesame_authenticator_core::{parse_otpauth, totp_code};
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::import::account::{self, AccountRequest, Answer, Ask, Challenge};
use opensesame_bitwarden_server::import::{self, vaultwarden, WriteOptions};
use opensesame_provider_bitwarden::{Kdf, MasterKey};
use serde_json::{json, Value};
use zeroize::Zeroizing;

fn code(key: &str, offset: i64) -> String {
    let uri = parse_otpauth(&format!("otpauth://totp/t?secret={key}")).unwrap();
    let at = chrono::Utc::now().timestamp() + offset * 30;
    totp_code(&uri, u64::try_from(at).unwrap()).unwrap()
}

async fn token(harness: &Harness, form: &[(&str, &str)]) -> (u16, Value) {
    let response = http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(form)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn sign_in(harness: &Harness, email: &str, hash: &str, extra: &[(&str, &str)]) -> u16 {
    let mut form = vec![
        ("grant_type", "password"),
        ("username", email),
        ("password", hash),
        ("scope", "api offline_access"),
        ("client_id", "web"),
        ("deviceType", "9"),
        ("deviceIdentifier", "moved-device"),
        ("deviceName", "chrome"),
    ];
    form.extend_from_slice(extra);
    token(harness, &form).await.0
}

async fn api_key_sign_in(harness: &Harness, user_id: &str, key: &str) -> u16 {
    token(
        harness,
        &[
            ("grant_type", "client_credentials"),
            ("client_id", &format!("user.{user_id}")),
            ("client_secret", key),
            ("scope", "api"),
            ("deviceType", "8"),
            ("deviceIdentifier", "cli"),
            ("deviceName", "linux"),
        ],
    )
    .await
    .0
}

#[tokio::test]
async fn a_vaultwarden_accounts_api_key_authenticator_and_recovery_code_move() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    let keys = fixture(&path).await;
    enable_two_step(&path).await;
    let source = vaultwarden::read(&path).await.unwrap();
    let arrival = &source.arrivals[0];
    // Email two-step cannot move; the authenticator can.
    assert_eq!(arrival.left_behind["two-step login methods"], 1);
    let target = Harness::start().await;
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();

    let hash = keys.login_hash.as_str();
    assert_eq!(sign_in(&target, EMAIL, hash, &[]).await, 400);
    let now = code(AUTHENTICATOR_KEY, 0);
    let with_code = [("twoFactorProvider", "0"), ("twoFactorToken", now.as_str())];
    assert_eq!(sign_in(&target, EMAIL, hash, &with_code).await, 200);
    let id = target
        .db
        .bitwarden_user_by_email(EMAIL)
        .await
        .unwrap()
        .unwrap()
        .id;
    assert_eq!(api_key_sign_in(&target, &id, API_KEY).await, 200);
    // vaultwarden kept the code in lower case; it is typed either way.
    let recovery = [("twoFactorProvider", "8"), ("twoFactorToken", RECOVERY)];
    assert_eq!(sign_in(&target, EMAIL, hash, &recovery).await, 200);
    assert_eq!(sign_in(&target, EMAIL, hash, &[]).await, 200);
}

struct Authenticator(String);
impl Ask for Authenticator {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
        assert!(
            matches!(challenge, Challenge::TwoFactor { .. }),
            "{challenge:?}"
        );
        Some(Answer {
            provider: Some(0),
            code: Zeroizing::new(code(&self.0, 1)),
        })
    }
}

async fn post(harness: &Harness, path: &str, access: &str, body: &Value) -> Value {
    let response = http()
        .request(reqwest::Method::POST, format!("{}{path}", harness.http_url))
        .bearer_auth(access)
        .json(body)
        .send()
        .await
        .unwrap();
    response.json().await.unwrap()
}

#[tokio::test]
async fn a_live_accounts_sign_in_methods_move_after_it_answers_the_challenge() {
    let light = Kdf::Argon2id {
        iterations: 2,
        memory_kib: 16 * 1024,
        parallelism: 1,
    };
    let old = Harness::start().await;
    let person = Account::register(&old.http_url, "moving@example.test", PASSWORD, light).await;
    let access = person.access_token(&old.http_url).await;
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let api_key = post(&old, "/api/accounts/api-key", &access, &proof).await["apiKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let issued = post(&old, "/api/two-factor/get-authenticator", &access, &proof).await;
    let key = issued["key"].as_str().unwrap().to_owned();
    let enable =
        json!({"key": key, "token": code(&key, 0), "masterPasswordHash": person.password_hash()});
    let response = http()
        .put(format!("{}/api/two-factor/authenticator", old.http_url))
        .bearer_auth(&access)
        .json(&enable)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let recovery = post(&old, "/api/two-factor/get-recover", &access, &proof).await["code"]
        .as_str()
        .unwrap()
        .to_owned();

    let source = account::read(
        &AccountRequest {
            server_url: &old.http_url,
            email: &person.email,
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut Authenticator(key.clone()),
    )
    .await
    .unwrap();
    let moved = &source.arrivals[0].account.sign_in;
    assert_eq!(moved.api_key.as_deref(), Some(api_key.as_str()));
    assert_eq!(moved.recovery_code.as_deref(), Some(recovery.as_str()));
    assert_eq!(moved.two_factors[0].data, key);

    let new = Harness::start().await;
    import::write(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();
    let hash = MasterKey::derive(PASSWORD.as_bytes(), &person.email, &light)
        .unwrap()
        .password_hash_b64(PASSWORD.as_bytes());
    assert_eq!(sign_in(&new, &person.email, &hash, &[]).await, 400);
    // The moved authenticator answers on the new server.
    let later = code(&key, 1);
    let answered = [
        ("twoFactorProvider", "0"),
        ("twoFactorToken", later.as_str()),
    ];
    assert_eq!(sign_in(&new, &person.email, &hash, &answered).await, 200);
    let id = new
        .db
        .bitwarden_user_by_email(&person.email)
        .await
        .unwrap()
        .unwrap()
        .id;
    assert_eq!(api_key_sign_in(&new, &id, &api_key).await, 200);
}
