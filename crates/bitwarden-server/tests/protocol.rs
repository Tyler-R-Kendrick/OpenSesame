//! Protocol behaviour that needs no oracle binary: refusals, isolation, and
//! the wire shapes the `bw` oracle depends on. Runs in ordinary CI.
mod common;

use common::client::{http, kdf_json, Account};
use common::Harness;
use opensesame_bitwarden_server::kdf::{KdfConfig, KdfPolicy};
use opensesame_provider_bitwarden::Kdf;
use serde_json::{json, Value};

/// Bitwarden's floor for Argon2id — cheap enough for a debug build.
const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};
const PASSWORD: &str = "a long enough master password";
const NAME: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async fn post(url: String, token: Option<&str>, body: &Value) -> (u16, Value) {
    let mut request = http().post(url).json(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn get(url: String, token: &str) -> (u16, Value) {
    let response = http().get(url).bearer_auth(token).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn token_form(harness: &Harness, form: &[(&str, &str)]) -> (u16, Value) {
    let response = http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(form)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

fn first_error(body: &Value) -> &str {
    body["validationErrors"][""][0].as_str().unwrap_or_default()
}

#[tokio::test]
async fn prelogin_answers_both_shapes_and_hides_unknown_accounts() {
    let harness = Harness::start().await;
    Account::register(&harness.http_url, "known@example.com", PASSWORD, LIGHT).await;
    for path in ["prelogin", "prelogin/password"] {
        let url = format!("{}/identity/accounts/{path}", harness.http_url);
        let (_, known) = post(url.clone(), None, &json!({"email": " Known@Example.com "})).await;
        assert_eq!(known["kdfSettings"], kdf_json(&LIGHT));
        assert_eq!(
            (known["kdf"].clone(), known["kdfMemory"].clone()),
            (json!(1), json!(16))
        );
        assert_eq!(known["salt"], "known@example.com");
        let (_, unknown) = post(url, None, &json!({"email": "nobody@example.com"})).await;
        assert_eq!(
            unknown["kdfSettings"],
            KdfConfig::ARGON2ID_DEFAULT.settings_json()
        );
    }
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_email_get_the_same_answer() {
    let harness = Harness::start().await;
    let account = Account::register(&harness.http_url, "p@example.com", PASSWORD, LIGHT).await;
    let form = |user: &'static str| {
        [
            ("grant_type", "password"),
            ("username", user),
            ("password", "bm90IHRoZSBoYXNo"),
            ("scope", "api offline_access"),
            ("client_id", "cli"),
            ("deviceIdentifier", "d"),
        ]
    };
    let wrong = token_form(&harness, &form("p@example.com")).await;
    let unknown = token_form(&harness, &form("q@example.com")).await;
    assert_eq!(wrong, unknown);
    assert_eq!(wrong.0, 400);
    assert_eq!(wrong.1["error"], "invalid_grant");
    assert_eq!(
        wrong.1["ErrorModel"]["Message"],
        "Username or password is incorrect. Try again."
    );
    let (status, body) = token_form(
        &harness,
        &[("grant_type", "client_credentials"), ("client_id", "x")],
    )
    .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("unsupported_grant_type"))
    );
    // The correct hash works, and the token carries the unlock material.
    let hash = account.password_hash();
    let mut good = form("p@example.com");
    good[2] = ("password", hash.as_str());
    let (status, body) = token_form(&harness, &good).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["UserDecryptionOptions"]["MasterPasswordUnlock"]["Salt"],
        "p@example.com"
    );
    assert_eq!(body["Kdf"], 1);
    assert!(body["Key"].as_str().unwrap().starts_with("2."));
}

#[tokio::test]
async fn accounts_are_isolated_and_revocation_is_immediate() {
    let harness = Harness::start().await;
    let base = &harness.http_url;
    let alice = Account::register(base, "alice@example.com", PASSWORD, LIGHT).await;
    let bob = Account::register(base, "bob@example.com", PASSWORD, LIGHT).await;
    let (alice_token, bob_token) = (alice.access_token(base).await, bob.access_token(base).await);

    let folder = post(
        format!("{base}/api/folders"),
        Some(&alice_token),
        &json!({"name": NAME}),
    )
    .await
    .1;
    let cipher =
        json!({"type": 2, "name": NAME, "secureNote": {"type": 0}, "folderId": folder["id"]});
    let (status, created) = post(format!("{base}/api/ciphers"), Some(&alice_token), &cipher).await;
    assert_eq!(status, 200);
    assert_eq!(created["object"], "cipherDetails");
    let id = created["id"].as_str().unwrap();

    // Bob can neither read Alice's cipher nor file his own into her folder.
    assert_eq!(
        get(format!("{base}/api/ciphers/{id}"), &bob_token).await.0,
        404
    );
    let (status, body) = post(format!("{base}/api/ciphers"), Some(&bob_token), &cipher).await;
    assert_eq!((status, first_error(&body)), (400, "Invalid folder."));
    let (_, sync) = get(format!("{base}/api/sync"), &bob_token).await;
    assert!(sync["ciphers"].as_array().unwrap().is_empty());

    // A stale edit is refused rather than overwriting a newer revision.
    let mut stale = cipher.clone();
    stale["lastKnownRevisionDate"] = json!("2001-01-01T00:00:00.000Z");
    let response = http()
        .put(format!("{base}/api/ciphers/{id}"))
        .bearer_auth(&alice_token)
        .json(&stale)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);

    // "Log out all sessions" ends every token at once.
    let proof = json!({"masterPasswordHash": alice.password_hash()});
    let (status, _) = post(
        format!("{base}/api/accounts/security-stamp"),
        Some(&alice_token),
        &proof,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(get(format!("{base}/api/sync"), &alice_token).await.0, 401);
    assert_eq!(
        http()
            .get(format!("{base}/api/sync"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

#[tokio::test]
async fn kdf_changes_are_policed() {
    let harness = Harness::start().await;
    let base = &harness.http_url;
    let mut account = Account::register(base, "k@example.com", PASSWORD, LIGHT).await;
    let token = account.access_token(base).await;
    let current = account.password_hash();
    let attempt = |auth_kdf: Value, unlock_kdf: Value, salt: &str| {
        json!({
            "masterPasswordHash": current,
            "authenticationData": {"kdf": auth_kdf, "masterPasswordAuthenticationHash": "aGFzaA==", "salt": salt},
            "unlockData": {"kdf": unlock_kdf, "masterKeyWrappedUserKey": NAME, "salt": salt},
        })
    };
    let argon = kdf_json(&LIGHT);
    let url = format!("{base}/api/accounts/kdf");
    let cases = [
        (
            attempt(
                argon.clone(),
                kdf_json(&common::client::ARGON2ID),
                "k@example.com",
            ),
            "KDF settings must be equal for authentication and unlock.",
        ),
        (
            attempt(argon.clone(), argon.clone(), "K@example.com"),
            "Invalid master password salt.",
        ),
        (
            attempt(
                json!({"kdfType": 1, "iterations": 1, "memory": 64, "parallelism": 4}),
                json!({"kdfType": 1, "iterations": 1, "memory": 64, "parallelism": 4}),
                "k@example.com",
            ),
            "KDF iterations must be between 2 and 10.",
        ),
        (
            attempt(
                json!({"kdfType": 0, "iterations": 100_000}),
                json!({"kdfType": 0, "iterations": 100_000}),
                "k@example.com",
            ),
            "KDF iterations must be between 600000 and 2000000.",
        ),
    ];
    for (body, expected) in cases {
        let (status, response) = post(url.clone(), Some(&token), &body).await;
        assert_eq!((status, first_error(&response)), (400, expected));
    }
    let mut wrong = attempt(argon.clone(), argon, "k@example.com");
    wrong["masterPasswordHash"] = json!("d3Jvbmc=");
    let (status, response) = post(url, Some(&token), &wrong).await;
    assert_eq!((status, first_error(&response)), (400, "Invalid password."));
    // Nothing above changed the account: the real change still goes through.
    assert!(account
        .change_kdf(base, common::client::PBKDF2)
        .await
        .status()
        .is_success());
}

#[tokio::test]
async fn an_operator_may_insist_on_argon2id() {
    let harness = Harness::start_with(|mut config| {
        config.kdf = KdfPolicy {
            allow_pbkdf2: false,
            ..KdfPolicy::default()
        };
        config
    })
    .await;
    let token: String = http()
        .post(format!(
            "{}/identity/accounts/register/send-verification-email",
            harness.http_url
        ))
        .json(&json!({"email": "strict@example.com"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let body = json!({
        "email": "strict@example.com",
        "emailVerificationToken": token,
        "masterPasswordHash": "aGFzaA==",
        "userSymmetricKey": NAME,
        "kdf": 0,
        "kdfIterations": 600_000,
    });
    let url = format!("{}/identity/accounts/register/finish", harness.http_url);
    let (status, response) = post(url, None, &body).await;
    assert_eq!(status, 400);
    assert!(
        first_error(&response).contains("requires Argon2id"),
        "{response}"
    );
}

#[tokio::test]
async fn config_and_known_device_speak_bitwarden() {
    let harness = Harness::start().await;
    let config: Value = http()
        .get(format!("{}/api/config", harness.http_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(config["object"], "config");
    assert_eq!(
        config["environment"]["identity"],
        format!("{}/identity", harness.https_url)
    );
    assert_eq!(config["server"]["name"], "OpenSesame");
    let known: bool = http()
        .get(format!("{}/api/devices/knowndevice", harness.http_url))
        .header("X-Request-Email", "bm9ib2R5QGV4YW1wbGUuY29t")
        .header("X-Device-Identifier", "d")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!known);
}

#[tokio::test]
async fn an_oversized_import_is_refused_whole() {
    let harness = Harness::start().await;
    let base = &harness.http_url;
    let account = Account::register(base, "big@example.com", PASSWORD, LIGHT).await;
    let token = account.access_token(base).await;
    let cipher = json!({"type": 2, "name": NAME, "secureNote": {"type": 0}});
    let body = json!({"ciphers": vec![cipher; 7_001], "folders": [], "folderRelationships": []});
    let (status, response) = post(format!("{base}/api/ciphers/import"), Some(&token), &body).await;
    assert_eq!(status, 400);
    assert!(first_error(&response).contains("7000"), "{response}");
    let (_, sync) = get(format!("{base}/api/sync"), &token).await;
    assert!(sync["ciphers"].as_array().unwrap().is_empty());
}
