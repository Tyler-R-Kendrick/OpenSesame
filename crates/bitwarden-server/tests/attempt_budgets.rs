//! Attempt admission at public and authenticated credential boundaries.
mod common;

use common::client::{http, Account};
use common::Harness;
use opensesame_provider_bitwarden::Kdf;
use serde_json::json;

const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};

async fn password(base: &str, email: &str, offered: &str) -> u16 {
    http()
        .post(format!("{base}/identity/connect/token"))
        .form(&[
            ("grant_type", "password"),
            ("username", email),
            ("password", offered),
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
async fn parallel_guesses_cannot_overrun_or_displace_the_account_fence() {
    let harness = Harness::start_with(|mut config| {
        config.max_failed_sign_ins = 3;
        config
    })
    .await;
    let user = Account::register(
        &harness.http_url,
        "limited@example.com",
        "a sufficiently long password",
        LIGHT,
    )
    .await;
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let base = harness.http_url.clone();
        tasks.push(tokio::spawn(async move {
            password(&base, "limited@example.com", "wrong").await
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap(), 400);
    }
    let attempts: i64 = sqlx::query_scalar(
        "SELECT attempts FROM bitwarden_attempt_budgets WHERE namespace='verification'",
    )
    .fetch_one(harness.db.pool())
    .await
    .unwrap();
    assert_eq!(attempts, 3);
    // Fabricated request identifiers used to allocate and evict live buckets.
    for index in 0..32 {
        assert_eq!(
            http()
                .get(format!(
                    "{}/api/auth-requests/fake-{index}/response?code=wrong",
                    harness.http_url
                ))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            404
        );
        let nonexistent_key = http()
            .post(format!("{}/identity/connect/token", harness.http_url))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", &format!("user.fake-{index}")),
                ("client_secret", "wrong"),
                ("deviceIdentifier", "d"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(nonexistent_key.status().as_u16(), 400);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bitwarden_attempt_budgets WHERE namespace='verification'",
    )
    .fetch_one(harness.db.pool())
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        password(&harness.http_url, &user.email, &user.password_hash()).await,
        400
    );
}

#[tokio::test]
async fn a_stolen_session_cannot_bypass_the_sign_in_budget_at_password_reproof() {
    let harness = Harness::start_with(|mut config| {
        config.max_failed_sign_ins = 3;
        config
    })
    .await;
    let user = Account::register(
        &harness.http_url,
        "stepup@example.com",
        "a sufficiently long password",
        LIGHT,
    )
    .await;
    let bearer = user.access_token(&harness.http_url).await;
    for _ in 0..3 {
        let response = http()
            .post(format!("{}/api/accounts/verify-password", harness.http_url))
            .bearer_auth(&bearer)
            .json(&json!({"masterPasswordHash":"wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
    }
    assert_eq!(
        password(&harness.http_url, &user.email, &user.password_hash()).await,
        400
    );
    let response = http()
        .post(format!("{}/api/accounts/verify-password", harness.http_url))
        .bearer_auth(&bearer)
        .json(&json!({"masterPasswordHash":user.password_hash()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 429);
    let rotation = http()
        .post(format!(
            "{}/api/accounts/key-management/rotate-user-account-keys",
            harness.http_url
        ))
        .bearer_auth(&bearer)
        .json(&json!({"oldMasterKeyAuthenticationHash": user.password_hash()}))
        .send()
        .await
        .unwrap();
    assert_eq!(rotation.status().as_u16(), 429);
}
