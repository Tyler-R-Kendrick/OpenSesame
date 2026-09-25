//! Account-level behaviour, with the official `bw` CLI as the oracle: a KDF
//! change from PBKDF2 to Argon2id, an imported legacy server hash upgraded on
//! sign-in, token refresh, and the operator's signup policy.
//!
//! `#[ignore]`d like `bw_cli_oracle.rs`; `pnpm test:bitwarden-oracle` runs it.
mod common;

use std::time::Duration;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHasher as _, SaltString};
use common::bw::Bw;
use common::client::{http, Account, ARGON2ID, PBKDF2};
use common::Harness;
use opensesame_bitwarden_server::SignupPolicy;
use serde_json::{json, Value};

const PASSWORD: &str = "correct horse battery staple";

async fn prelogin(harness: &Harness, email: &str) -> Value {
    http()
        .post(format!(
            "{}/identity/accounts/prelogin/password",
            harness.http_url
        ))
        .json(&json!({"email": email}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn a_pbkdf2_account_moves_to_argon2id_and_bw_follows() {
    let harness = Harness::start().await;
    let mut bob = Account::register(&harness.http_url, "bob@example.com", PASSWORD, PBKDF2).await;
    assert_eq!(
        prelogin(&harness, "bob@example.com").await["kdfSettings"]["kdfType"],
        0
    );

    let mut bw = Bw::new(&harness).await;
    bw.login("bob@example.com", PASSWORD).await;
    let item = json!({"type": 1, "name": "Mail", "login": {"username": "bob", "password": "before-kdf-change"}});
    bw.create("item", &item).await;

    // The web vault's KDF change: same user key, re-wrapped under Argon2id.
    let changed = bob.change_kdf(&harness.http_url, ARGON2ID).await;
    assert!(
        changed.status().is_success(),
        "{}",
        changed.text().await.unwrap()
    );
    let after = prelogin(&harness, "bob@example.com").await;
    assert_eq!(
        after["kdfSettings"],
        json!({"kdfType": 1, "iterations": 3, "memory": 64, "parallelism": 4})
    );
    assert_eq!(after["kdf"], 1);

    // The old session's tokens died with the security stamp.
    let revoked = bw.fails(&["sync"]).await;
    assert!(!revoked.contains("Syncing complete"), "{revoked}");

    // bw signs in again — now deriving with Argon2id — and nothing was re-encrypted.
    let mut fresh = Bw::new(&harness).await;
    fresh.login("bob@example.com", PASSWORD).await;
    assert_eq!(
        fresh.ok(&["get", "password", "Mail"]).await,
        "before-kdf-change"
    );
    let stored = harness
        .db
        .bitwarden_user_by_email("bob@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((stored.kdf.kdf_type, stored.kdf.memory), (1, Some(64)));
    assert!(
        harness.unrouted().is_empty(),
        "unrouted: {:#?}",
        harness.unrouted()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn an_imported_legacy_server_hash_upgrades_on_bw_sign_in() {
    let harness = Harness::start().await;
    let carol = Account::register(&harness.http_url, "carol@example.com", PASSWORD, ARGON2ID).await;
    let user = harness
        .db
        .bitwarden_user_by_email("carol@example.com")
        .await
        .unwrap()
        .unwrap();

    // What a Bitwarden or vaultwarden server would have stored: PBKDF2-SHA256
    // over the client hash, in PHC form.
    let salt = SaltString::generate(&mut OsRng);
    let params = pbkdf2::Params {
        rounds: 100_000,
        output_length: 32,
    };
    let legacy = pbkdf2::Pbkdf2
        .hash_password_customized(
            carol.password_hash().as_bytes(),
            Some(pbkdf2::Algorithm::Pbkdf2Sha256.ident()),
            None,
            params,
            &salt,
        )
        .unwrap()
        .to_string();
    harness
        .db
        .bitwarden_set_password_hash(&user.id, &user.master_password_hash, &legacy)
        .await
        .unwrap();

    let mut bw = Bw::new(&harness).await;
    bw.login("carol@example.com", PASSWORD).await;
    let upgraded = harness
        .db
        .bitwarden_user_by_email("carol@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(
        upgraded.master_password_hash.starts_with("$argon2id$"),
        "{}",
        upgraded.master_password_hash
    );
    // …and the upgraded hash is the one that works from now on.
    bw.ok(&["logout"]).await;
    bw.login("carol@example.com", PASSWORD).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_refreshes_short_lived_access_tokens() {
    let harness = Harness::start_with(|mut config| {
        config.access_token_ttl = Duration::from_secs(60);
        config
    })
    .await;
    Account::register(&harness.http_url, "dave@example.com", PASSWORD, ARGON2ID).await;
    let mut bw = Bw::new(&harness).await;
    bw.login("dave@example.com", PASSWORD).await;
    let before = harness.seen().len();
    bw.ok(&["sync", "--force"]).await;
    bw.ok(&["sync", "--force"]).await;
    let refreshes = harness.seen()[before..]
        .iter()
        .filter(|line| line.ends_with("/identity/connect/token"))
        .count();
    // bw refreshes any token within five minutes of expiry, so each command
    // above went through the refresh grant — and still succeeded.
    assert!(refreshes >= 1, "{:#?}", harness.seen());
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_signups_refuse_registration() {
    let harness = Harness::start_with(|mut config| {
        config.signups = SignupPolicy::Closed;
        config
    })
    .await;
    let response = http()
        .post(format!(
            "{}/identity/accounts/register/send-verification-email",
            harness.http_url
        ))
        .json(&json!({"email": "eve@example.com"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["validationErrors"][""][0],
        "Registration has been disabled by the system administrator."
    );
}
