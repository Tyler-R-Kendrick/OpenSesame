//! The races and abuse cases a review of the surface found, each pinned at
//! the boundary that now refuses it. Runs in ordinary CI.
mod common;

use chrono::{Duration, Utc};
use common::client::{http, Account};
use common::Harness;
use opensesame_provider_bitwarden::Kdf;
use opensesame_storage::bitwarden::{BitwardenCipher, BitwardenSignIn};
use serde_json::{json, Value};

const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};
const PASSWORD: &str = "a long enough master password";

async fn refresh(harness: &Harness, token: &str) -> (u16, Value) {
    let response = http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", token),
            ("client_id", "web"),
        ])
        .send()
        .await
        .unwrap();
    (
        response.status().as_u16(),
        response.json().await.unwrap_or(Value::Null),
    )
}

fn sign_in<'a>(
    user_id: &'a str,
    token_hash: &'a str,
    stamp: &'a str,
    expires: chrono::DateTime<Utc>,
) -> BitwardenSignIn<'a> {
    BitwardenSignIn {
        user_id,
        identifier: token_hash,
        name: "raced",
        device_type: 9,
        refresh_token_hash: token_hash,
        security_stamp: stamp,
        refresh_expires_at: expires,
    }
}

async fn password_grant(harness: &Harness, email: &str, hash: &str) -> u16 {
    http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&[
            ("grant_type", "password"),
            ("username", email),
            ("password", hash),
            ("client_id", "web"),
            ("deviceIdentifier", "d"),
        ])
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn a_rehash_never_overwrites_a_hash_that_changed_meanwhile() {
    let harness = Harness::start().await;
    Account::register(&harness.http_url, "r@example.com", PASSWORD, LIGHT).await;
    let user = harness
        .db
        .bitwarden_user_by_email("r@example.com")
        .await
        .unwrap()
        .unwrap();
    // A sign-in verified an older hash, then a password change stored this one.
    let stale = "$argon2id$v=19$m=64,t=1,p=1$c3RhbGVzYWx0$c3RhbGVoYXNo";
    assert!(!harness
        .db
        .bitwarden_set_password_hash(&user.id, stale, "$argon2id$replacement")
        .await
        .unwrap());
    let after = harness
        .db
        .bitwarden_user_by_id(&user.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.master_password_hash, user.master_password_hash);
}

#[tokio::test]
async fn refresh_tokens_die_with_the_stamp_and_lapse_when_unused() {
    let harness = Harness::start().await;
    let base = &harness.http_url;
    let account = Account::register(base, "t@example.com", PASSWORD, LIGHT).await;
    let body = account.sign_in(base).await;
    let token = body["refresh_token"].as_str().unwrap().to_owned();
    assert_eq!(refresh(&harness, &token).await.0, 200);

    // "Log out all sessions" rotates the stamp: the token is refused.
    let access = body["access_token"].as_str().unwrap();
    let proof = json!({"masterPasswordHash": account.password_hash()});
    let rotated = http()
        .post(format!("{base}/api/accounts/security-stamp"))
        .bearer_auth(access)
        .json(&proof)
        .send()
        .await
        .unwrap();
    assert!(rotated.status().is_success());
    let (status, refused) = refresh(&harness, &token).await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (400, Some("invalid_grant"))
    );

    // A sign-in that raced a password change stored its token under the old
    // stamp after the change cleared every token: still refused.
    let user = harness
        .db
        .bitwarden_user_by_email("t@example.com")
        .await
        .unwrap()
        .unwrap();
    let hash = |t: &str| opensesame_bitwarden_server::tokens::refresh_token_hash(t);
    let raced_hash = hash("raced-token");
    let raced = sign_in(
        &user.id,
        &raced_hash,
        "the-stamp-before-the-change",
        Utc::now() + Duration::days(1),
    );
    harness.db.bitwarden_upsert_device(&raced).await.unwrap();
    assert_eq!(refresh(&harness, "raced-token").await.0, 400);

    // A token under the current stamp but past its lifetime: refused.
    let lapsed_hash = hash("lapsed-token");
    let lapsed = sign_in(
        &user.id,
        &lapsed_hash,
        &user.security_stamp,
        Utc::now() - Duration::seconds(1),
    );
    harness.db.bitwarden_upsert_device(&lapsed).await.unwrap();
    assert_eq!(refresh(&harness, "lapsed-token").await.0, 400);
}

#[tokio::test]
async fn repeated_failures_are_refused_before_any_hash_known_or_not() {
    let harness = Harness::start_with(|mut config| {
        config.max_failed_sign_ins = 3;
        config
    })
    .await;
    let account = Account::register(&harness.http_url, "l@example.com", PASSWORD, LIGHT).await;
    for _ in 0..3 {
        assert_eq!(
            password_grant(&harness, "l@example.com", "d3Jvbmc=").await,
            400
        );
        assert_eq!(
            password_grant(&harness, "ghost@example.com", "d3Jvbmc=").await,
            400
        );
    }
    // Even the right password waits out the window; the unknown address is
    // treated the same way, so the limiter does not reveal which exists.
    assert_eq!(
        password_grant(&harness, "l@example.com", &account.password_hash()).await,
        429
    );
    assert_eq!(
        password_grant(&harness, "ghost@example.com", "d3Jvbmc=").await,
        429
    );
    // Other addresses are unaffected.
    let other = Account::register(&harness.http_url, "m@example.com", PASSWORD, LIGHT).await;
    assert_eq!(
        password_grant(&harness, "m@example.com", &other.password_hash()).await,
        200
    );
}

#[tokio::test]
async fn an_address_with_two_at_signs_cannot_slip_past_a_domain_list() {
    let harness = Harness::start_with(|mut config| {
        config.signups = opensesame_bitwarden_server::SignupPolicy::parse("corp.example");
        config
    })
    .await;
    let response = http()
        .post(format!(
            "{}/identity/accounts/register/send-verification-email",
            harness.http_url
        ))
        .json(&json!({"email": "x@evil.example@corp.example"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn writes_are_atomic_against_concurrent_edits_and_folder_deletes() {
    let harness = Harness::start().await;
    Account::register(&harness.http_url, "c@example.com", PASSWORD, LIGHT).await;
    let user = harness
        .db
        .bitwarden_user_by_email("c@example.com")
        .await
        .unwrap()
        .unwrap();
    let now = Utc::now();
    let cipher = BitwardenCipher {
        id: "5f0c5e2a-0000-4000-8000-0000000000c1".into(),
        user_id: user.id.clone(),
        // A folder that was deleted between the check and the write.
        folder_id: Some("5f0c5e2a-0000-4000-8000-00000000dead".into()),
        cipher_type: 2,
        favorite: false,
        data: "{}".into(),
        created_at: now,
        revision_at: now,
        deleted_at: None,
        archived_at: None,
    };
    harness.db.bitwarden_insert_cipher(&cipher).await.unwrap();
    let stored = harness
        .db
        .bitwarden_cipher(&user.id, &cipher.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.folder_id, None,
        "a vanished folder falls back to no folder"
    );

    // Two edits read the same revision; the second one to write is refused.
    let mut first = stored.clone();
    first.revision_at = now + Duration::seconds(1);
    first.data = "{\"first\":true}".into();
    let mut second = stored.clone();
    second.revision_at = now + Duration::seconds(2);
    second.data = "{\"second\":true}".into();
    assert!(harness
        .db
        .bitwarden_update_cipher(&first, stored.revision_at)
        .await
        .unwrap());
    assert!(!harness
        .db
        .bitwarden_update_cipher(&second, stored.revision_at)
        .await
        .unwrap());
    let kept = harness
        .db
        .bitwarden_cipher(&user.id, &cipher.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.data, first.data);

    // A key pair is set once; a second set is refused, not an overwrite.
    assert!(!harness
        .db
        .bitwarden_set_keys(&user.id, "pk", "2.x|y|z")
        .await
        .unwrap());
}
