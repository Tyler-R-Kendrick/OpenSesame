//! The importer end to end (ADR 0148): a vaultwarden database and a live
//! account move onto the server, and the person's own master password then
//! opens the same vault through a real Bitwarden client key schedule.

mod common;

use std::sync::{Arc, Mutex};

use axum::extract::{Form, Path as UrlPath};
use axum::routing::{get, post};
use axum::{Json, Router};
use common::client::{encrypt, http, Account, ARGON2ID};
use common::vaultwarden::{fixture, keys, Keys, EMAIL, LOGIN, PASSWORD};
use common::Harness;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::import::account::{self, AccountRequest, Answer, Ask, Challenge};
use opensesame_bitwarden_server::import::{self, vaultwarden, WriteOptions, Written};
use opensesame_provider_bitwarden::{BitwardenClient, Config, MIN_PBKDF2_ITERATIONS};
use secrecy::SecretString;
use serde_json::{json, Value};
use zeroize::Zeroizing;

async fn unlock(base: &str, email: &str) -> BitwardenClient {
    BitwardenClient::unlock(
        Config::from_server_url(base).unwrap(),
        email,
        &SecretString::from(PASSWORD.to_owned()),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_vaultwarden_server_moves_over_and_the_same_password_opens_the_same_vault() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    fixture(&path).await;

    let source = vaultwarden::read(&path).await.unwrap();
    let skipped: Vec<&str> = source.skipped.iter().map(|s| s.email.as_str()).collect();
    assert_eq!(skipped, ["invited@example.test", "off@example.test"]);
    assert_eq!(source.left_behind["organizations"], 1);
    assert_eq!(source.left_behind["organization items"], 1);
    let arrival = &source.arrivals[0];
    assert_eq!(arrival.left_behind["attachments"], 1);
    assert!(!arrival.left_behind.contains_key("unreadable items"));

    let target = Harness::start().await;
    let reports = import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(reports[0].written, Written::Created);
    assert_eq!((reports[0].folders, reports[0].ciphers), (1, 2));

    // The person's master password, unchanged, through a real key schedule.
    let mut client = unlock(&target.http_url, EMAIL).await;
    assert_eq!(client.read("Bank").await.unwrap().as_str(), "hunter2");
    let vault = client.vault().await.unwrap();
    let bank = vault.items.iter().find(|i| i.id == LOGIN).unwrap();
    assert!(bank.favorite);
    assert_eq!(bank.folder.as_deref(), Some("Money"));
    let login = bank.login.as_ref().unwrap();
    assert_eq!(login.username.as_deref(), Some("alice"));
    // The trashed note stays in the trash.
    assert_eq!(vault.skipped_deleted, 1);
    assert!(vault.unreadable.is_empty());

    // The first sign-in replaced vaultwarden's PBKDF2 with Argon2id.
    let stored = target
        .db
        .bitwarden_user_by_email(EMAIL)
        .await
        .unwrap()
        .unwrap();
    assert!(stored.master_password_hash.starts_with("$argon2id$"));
    assert_eq!(stored.master_password_hint.as_deref(), Some("the horse"));
}

#[tokio::test]
async fn a_second_run_leaves_the_account_alone_unless_told_to_replace_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    fixture(&path).await;
    let source = vaultwarden::read(&path).await.unwrap();
    let target = Harness::start().await;
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    let again = import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(again[0].written, Written::EmailTaken);
    let replaced = import::write(
        &target.db,
        &source,
        WriteOptions {
            replace: true,
            dry_run: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(replaced[0].written, Written::Replaced);
    let user = target
        .db
        .bitwarden_user_by_email(EMAIL)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        target.db.bitwarden_ciphers(&user.id).await.unwrap().len(),
        2
    );
}

#[tokio::test]
async fn a_file_that_is_not_vaultwarden_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("other.sqlite3");
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE users (id TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let refused = vaultwarden::read(&path).await.unwrap_err();
    assert!(
        refused.to_string().contains("not a vaultwarden database"),
        "{refused}"
    );
    assert!(vaultwarden::read(&dir.path().join("missing"))
        .await
        .is_err());
}

struct Never;
impl Ask for Never {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
        panic!("no challenge expected, got {challenge:?}")
    }
}

#[tokio::test]
async fn a_live_account_moves_with_its_keys_folders_and_ciphers() {
    let old = Harness::start().await;
    let person = Account::register(&old.http_url, "live@example.test", PASSWORD, ARGON2ID).await;
    let token = person.access_token(&old.http_url).await;
    let key = person.user_key();
    let folder: Value = http()
        .post(format!("{}/api/folders", old.http_url))
        .bearer_auth(&token)
        .json(&json!({"name": encrypt(&key, b"Work")}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let created: Value = http()
        .post(format!("{}/api/ciphers", old.http_url))
        .bearer_auth(&token)
        .json(&json!({
            "type": 1, "name": encrypt(&key, b"Mail"), "folderId": folder["id"],
            "login": {"username": encrypt(&key, b"me"), "password": encrypt(&key, b"s3cret")},
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let source = account::read(
        &AccountRequest {
            server_url: &old.http_url,
            email: "Live@Example.test ",
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut Never,
    )
    .await
    .unwrap();
    let new = Harness::start().await;
    let reports = import::write(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(reports[0].written, Written::Created);
    assert_eq!(reports[0].email, "live@example.test");

    let mut client = unlock(&new.http_url, "live@example.test").await;
    assert_eq!(client.read("Mail").await.unwrap().as_str(), "s3cret");
    let vault = client.vault().await.unwrap();
    let mail = &vault.items[0];
    assert_eq!(mail.id, created["id"].as_str().unwrap());
    assert_eq!(mail.folder.as_deref(), Some("Work"));
    let moved = new
        .db
        .bitwarden_user_by_email("live@example.test")
        .await
        .unwrap()
        .unwrap();
    let before = old
        .db
        .bitwarden_user_by_email("live@example.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.id, before.id);
    assert_eq!(moved.user_key, before.user_key);
    assert_eq!(moved.public_key, before.public_key);
    assert_eq!(moved.private_key, before.private_key);
    assert_eq!(moved.kdf, before.kdf);
}

#[tokio::test]
async fn a_wrong_master_password_moves_nothing() {
    let old = Harness::start().await;
    Account::register(&old.http_url, "wrong@example.test", PASSWORD, ARGON2ID).await;
    let refused = account::read(
        &AccountRequest {
            server_url: &old.http_url,
            email: "wrong@example.test",
            master_password: b"not the password",
        },
        &HashRegistry::default(),
        &mut Never,
    )
    .await;
    assert!(refused.is_err());
}

/// An old server that asks for a two-step code, then a new-device code.
fn challenging_server(keys: Arc<Keys>, seen: Arc<Mutex<Vec<String>>>) -> Router {
    let token = move |Form(form): Form<std::collections::HashMap<String, String>>| {
        let (keys, seen) = (keys.clone(), seen.clone());
        async move {
            assert_eq!(form["password"], keys.login_hash);
            let two_factor = form.get("twoFactorToken").map(String::as_str);
            let device = form.get("newdeviceotp").map(String::as_str);
            seen.lock()
                .unwrap()
                .push(format!("{two_factor:?} {device:?}"));
            let body = match (two_factor, device) {
                (None, _) => json!({"error": "invalid_grant", "TwoFactorProviders": ["0", "1"]}),
                (Some("123456"), None) => json!({"error": "invalid_grant",
                    "error_description": "New device verification required."}),
                (Some("123456"), Some("777")) => {
                    return (
                        axum::http::StatusCode::OK,
                        Json(json!({"access_token": "t"})),
                    );
                }
                _ => json!({"error": "invalid_grant", "error_description": "bad code"}),
            };
            (axum::http::StatusCode::BAD_REQUEST, Json(body))
        }
    };
    Router::new()
        .route(
            "/identity/accounts/prelogin",
            post(|| async { Json(json!({"kdf": 0, "kdfIterations": MIN_PBKDF2_ITERATIONS})) }),
        )
        .route("/identity/connect/token", post(token))
        .route(
            "/api/users/{id}/public-key",
            get(|UrlPath(id): UrlPath<String>| async move {
                Json(json!({"userId": id, "publicKey": "MIIB"}))
            }),
        )
}

struct GiveUp;
impl Ask for GiveUp {
    fn ask(&mut self, _: &Challenge) -> Option<Answer> {
        None
    }
}

struct Scripted(Vec<Challenge>);
impl Ask for Scripted {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
        self.0.push(challenge.clone());
        let code = match challenge {
            Challenge::TwoFactor { .. } => "123456",
            Challenge::NewDevice => "777",
        };
        Some(Answer {
            provider: Some(0),
            code: Zeroizing::new(code.to_owned()),
        })
    }
}

#[tokio::test]
async fn two_step_and_new_device_challenges_are_put_to_the_person() {
    let email = "twostep@example.test";
    let keys = Arc::new(keys(email));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let wrapped = keys.wrapped_user_key.clone();
    let app = challenging_server(keys.clone(), seen.clone()).route(
        "/api/sync",
        get(move || {
            let wrapped = wrapped.clone();
            async move {
                Json(
                    json!({"profile": {"id": "u-2", "email": email, "key": wrapped},
                            "folders": [], "ciphers": [], "sends": []}),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut asked = Scripted(Vec::new());
    let source = account::read(
        &AccountRequest {
            server_url: &base,
            email,
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut asked,
    )
    .await
    .unwrap();
    assert_eq!(
        asked.0,
        [
            Challenge::TwoFactor {
                providers: vec![0, 1]
            },
            Challenge::NewDevice
        ]
    );
    assert_eq!(
        *seen.lock().unwrap(),
        [
            "None None",
            "Some(\"123456\") None",
            "Some(\"123456\") Some(\"777\")"
        ]
    );
    assert_eq!(source.arrivals[0].account.user.id, "u-2");
    assert_eq!(
        source.arrivals[0].account.user.public_key.as_deref(),
        Some("MIIB")
    );

    let refused = account::read(
        &AccountRequest {
            server_url: &base,
            email,
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut GiveUp,
    )
    .await
    .unwrap_err();
    assert!(refused.to_string().contains("not answered"), "{refused}");
}
