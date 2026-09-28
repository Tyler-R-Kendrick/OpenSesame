//! Sign-in methods beside the master password (ADR 0148): the personal API
//! key, an authenticator as a second step, "remember this device", and the
//! recovery code. Runs in ordinary CI; the `bw` oracle drives the same flows
//! in `bw_cli_oracle_sign_in.rs`.
mod common;

use common::client::{http, Account};
use common::Harness;
use opensesame_authenticator_core::{parse_otpauth, totp_code};
use opensesame_provider_bitwarden::Kdf;
use serde_json::{json, Value};

const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};
const PASSWORD: &str = "a long enough master password";

/// The code an authenticator app shows `offset` steps from now.
fn code(key: &str, offset: i64) -> String {
    let uri = parse_otpauth(&format!("otpauth://totp/t?secret={key}")).unwrap();
    let at = chrono::Utc::now().timestamp() + offset * 30;
    totp_code(&uri, u64::try_from(at).unwrap()).unwrap()
}

async fn post(harness: &Harness, path: &str, token: Option<&str>, body: &Value) -> (u16, Value) {
    let mut request = http()
        .post(format!("{}{path}", harness.http_url))
        .json(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn put(harness: &Harness, path: &str, token: &str, body: &Value) -> (u16, Value) {
    let response = http()
        .put(format!("{}{path}", harness.http_url))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn token(harness: &Harness, form: &[(&str, &str)]) -> (u16, Value) {
    let response = http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(form)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

async fn password_sign_in(
    harness: &Harness,
    person: &Account,
    extra: &[(&str, &str)],
) -> (u16, Value) {
    let hash = person.password_hash();
    let mut form = vec![
        ("grant_type", "password"),
        ("username", person.email.as_str()),
        ("password", hash.as_str()),
        ("scope", "api offline_access"),
        ("client_id", "web"),
        ("deviceType", "9"),
        ("deviceIdentifier", "two-step-test-device"),
        ("deviceName", "chrome"),
    ];
    form.extend_from_slice(extra);
    token(harness, &form).await
}

async fn grant(harness: &Harness, client_id: &str, secret: &str) -> (u16, Value) {
    token(
        harness,
        &[
            ("grant_type", "client_credentials"),
            ("client_id", client_id),
            ("client_secret", secret),
            ("scope", "api"),
            ("deviceType", "8"),
            ("deviceIdentifier", "cli-device"),
            ("deviceName", "linux"),
        ],
    )
    .await
}

/// Turn the authenticator on; returns its key.
async fn enable_authenticator(harness: &Harness, person: &Account, access: &str) -> String {
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let (status, issued) = post(
        harness,
        "/api/two-factor/get-authenticator",
        Some(access),
        &proof,
    )
    .await;
    assert_eq!(status, 200, "{issued}");
    assert_eq!(issued["enabled"], false);
    let key = issued["key"].as_str().unwrap().to_owned();
    // A wrong code sets nothing up.
    let wrong = json!({"key": key, "token": "000000",
                       "userVerificationToken": issued["userVerificationToken"]});
    assert_eq!(
        put(harness, "/api/two-factor/authenticator", access, &wrong)
            .await
            .0,
        400
    );
    let right = json!({"key": key, "token": code(&key, 0),
                       "userVerificationToken": issued["userVerificationToken"]});
    let (status, enabled) = put(harness, "/api/two-factor/authenticator", access, &right).await;
    assert_eq!(status, 200, "{enabled}");
    assert_eq!(enabled["enabled"], true);
    key
}

#[tokio::test]
async fn an_api_key_signs_in_without_a_refresh_token_and_rotation_retires_it() {
    let harness = Harness::start().await;
    let person = Account::register(&harness.http_url, "api@example.test", PASSWORD, LIGHT).await;
    let access = person.access_token(&harness.http_url).await;
    let refused = post(
        &harness,
        "/api/accounts/api-key",
        Some(&access),
        &json!({"masterPasswordHash": "nope"}),
    )
    .await;
    assert_eq!(refused.0, 400);
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let (_, issued) = post(&harness, "/api/accounts/api-key", Some(&access), &proof).await;
    let key = issued["apiKey"].as_str().unwrap().to_owned();
    assert_eq!(key.len(), 30);
    // Asking again shows the same key.
    assert_eq!(
        post(&harness, "/api/accounts/api-key", Some(&access), &proof)
            .await
            .1["apiKey"],
        key
    );

    let id = harness
        .db
        .bitwarden_user_by_email(&person.email)
        .await
        .unwrap()
        .unwrap()
        .id;
    let client_id = format!("user.{id}");
    let (status, body) = grant(&harness, &client_id, &key).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("refresh_token").is_none(), "{body}");
    assert_eq!(
        body["Key"],
        harness
            .db
            .bitwarden_user_by_id(&id)
            .await
            .unwrap()
            .unwrap()
            .user_key
    );
    let sync = http()
        .get(format!("{}/api/sync", harness.http_url))
        .bearer_auth(body["access_token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(sync.status().as_u16(), 200);
    assert_eq!(grant(&harness, &client_id, "wrong").await.0, 400);

    let (_, rotated) = post(
        &harness,
        "/api/accounts/rotate-api-key",
        Some(&access),
        &proof,
    )
    .await;
    assert_ne!(rotated["apiKey"], key);
    assert_eq!(grant(&harness, &client_id, &key).await.0, 400);
    assert_eq!(
        grant(&harness, &client_id, rotated["apiKey"].as_str().unwrap())
            .await
            .0,
        200
    );
}

#[tokio::test]
async fn an_authenticator_is_asked_for_checked_once_and_can_be_remembered() {
    let harness = Harness::start().await;
    let person = Account::register(&harness.http_url, "otp@example.test", PASSWORD, LIGHT).await;
    let access = person.access_token(&harness.http_url).await;
    let key = enable_authenticator(&harness, &person, &access).await;

    // The password alone gets a challenge naming the authenticator.
    let (status, challenge) = password_sign_in(&harness, &person, &[]).await;
    assert_eq!(status, 400);
    assert_eq!(challenge["TwoFactorProviders"], json!(["0"]));
    assert!(
        challenge["TwoFactorProviders2"].get("0").is_some(),
        "{challenge}"
    );

    // The code enabling spent this step; the next one is good, once.
    let next = code(&key, 1);
    let with_code = [
        ("twoFactorProvider", "0"),
        ("twoFactorToken", next.as_str()),
        ("twoFactorRemember", "1"),
    ];
    let (status, signed_in) = password_sign_in(&harness, &person, &with_code).await;
    assert_eq!(status, 200, "{signed_in}");
    let remember = signed_in["TwoFactorToken"].as_str().unwrap().to_owned();
    assert_eq!(password_sign_in(&harness, &person, &with_code).await.0, 400);

    // The remembered device skips the code; a made-up token is asked again.
    let remembered = [
        ("twoFactorProvider", "5"),
        ("twoFactorToken", remember.as_str()),
    ];
    assert_eq!(
        password_sign_in(&harness, &person, &remembered).await.0,
        200
    );
    let (_, again) = password_sign_in(
        &harness,
        &person,
        &[("twoFactorProvider", "5"), ("twoFactorToken", "x")],
    )
    .await;
    assert_eq!(again["TwoFactorProviders"], json!(["0"]));

    let profile: Value = http()
        .get(format!("{}/api/accounts/profile", harness.http_url))
        .bearer_auth(&access)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(profile["twoFactorEnabled"], true);

    // Turning it off takes the password; then the password alone signs in,
    // and the remembered token is forgotten with it.
    let off = json!({"type": 0, "masterPasswordHash": person.password_hash()});
    assert_eq!(
        put(&harness, "/api/two-factor/disable", &access, &off)
            .await
            .1["enabled"],
        false
    );
    assert_eq!(password_sign_in(&harness, &person, &[]).await.0, 200);
}

#[tokio::test]
async fn the_recovery_code_turns_two_step_off_once() {
    let harness = Harness::start().await;
    let person = Account::register(&harness.http_url, "lost@example.test", PASSWORD, LIGHT).await;
    let access = person.access_token(&harness.http_url).await;
    enable_authenticator(&harness, &person, &access).await;
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let (_, recover) = post(
        &harness,
        "/api/two-factor/get-recover",
        Some(&access),
        &proof,
    )
    .await;
    let recovery = recover["code"].as_str().unwrap().to_owned();
    assert_eq!(recovery.len(), 32);

    // Wrong code, or the right code with the wrong password: one answer.
    let attempt = |password: String, code: String| json!({"email": person.email, "masterPasswordHash": password, "recoveryCode": code});
    assert_eq!(
        post(
            &harness,
            "/api/two-factor/recover",
            None,
            &attempt(person.password_hash(), "WRONG".into())
        )
        .await
        .0,
        400
    );
    assert_eq!(
        post(
            &harness,
            "/api/two-factor/recover",
            None,
            &attempt("nope".into(), recovery.clone())
        )
        .await
        .0,
        400
    );
    assert_eq!(password_sign_in(&harness, &person, &[]).await.0, 400);

    let lower = recovery.to_ascii_lowercase();
    assert_eq!(
        post(
            &harness,
            "/api/two-factor/recover",
            None,
            &attempt(person.password_hash(), lower)
        )
        .await
        .0,
        200
    );
    assert_eq!(password_sign_in(&harness, &person, &[]).await.0, 200);
    assert_eq!(
        post(
            &harness,
            "/api/two-factor/recover",
            None,
            &attempt(person.password_hash(), recovery)
        )
        .await
        .0,
        400
    );
}

#[tokio::test]
async fn the_recovery_code_is_also_a_second_step_that_ends_two_step_login() {
    let harness = Harness::start().await;
    let person = Account::register(&harness.http_url, "code8@example.test", PASSWORD, LIGHT).await;
    let access = person.access_token(&harness.http_url).await;
    enable_authenticator(&harness, &person, &access).await;
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let recovery = post(
        &harness,
        "/api/two-factor/get-recover",
        Some(&access),
        &proof,
    )
    .await
    .1["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let with_recovery = [
        ("twoFactorProvider", "8"),
        ("twoFactorToken", recovery.as_str()),
    ];
    assert_eq!(
        password_sign_in(&harness, &person, &with_recovery).await.0,
        200
    );
    assert_eq!(password_sign_in(&harness, &person, &[]).await.0, 200);
}
