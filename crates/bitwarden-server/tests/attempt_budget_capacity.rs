//! Invented identities must not consume another credential's durable budget capacity.
mod common;

use common::client::{http, Account};
use common::Harness;
use opensesame_provider_bitwarden::Kdf;
use serde_json::{json, Value};

const LIGHT: Kdf = Kdf::Argon2id {
    iterations: 2,
    memory_kib: 16 * 1024,
    parallelism: 1,
};
const ENC: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAA";

async fn password_response(base: &str, email: &str, offered: &str) -> reqwest::Response {
    http()
        .post(format!("{base}/identity/connect/token"))
        .form(&[
            ("grant_type", "password"),
            ("username", email),
            ("password", offered),
            ("client_id", "web"),
            ("deviceIdentifier", "capacity-device"),
        ])
        .send()
        .await
        .unwrap()
}

async fn password(base: &str, email: &str, offered: &str) -> u16 {
    password_response(base, email, offered)
        .await
        .status()
        .as_u16()
}

#[tokio::test]
async fn mass_unknown_password_recovery_and_device_requests_allocate_no_buckets() {
    let harness = Harness::start().await;
    let user = Account::register(
        &harness.http_url,
        "real-victim@example.test",
        "a sufficiently long password",
        LIGHT,
    )
    .await;
    let mut tasks = Vec::new();
    for index in 0..32 {
        let base = harness.http_url.clone();
        tasks.push(tokio::spawn(async move {
            let email = format!("made-up-{index}@example.test");
            assert_eq!(password(&base, &email, "wrong").await, 400);
            let recovery = http()
                .post(format!("{base}/api/two-factor/recover"))
                .json(&json!({"email":email,"masterPasswordHash":"wrong","recoveryCode":"wrong"}))
                .send()
                .await
                .unwrap();
            assert_eq!(recovery.status().as_u16(), 400);
            let request = http()
                .post(format!("{base}/api/auth-requests"))
                .json(
                    &json!({"email":email,"publicKey":"fixture-public-key","deviceIdentifier":"d",
                    "accessCode":"fixture-request-access-code","type":0}),
                )
                .send()
                .await
                .unwrap();
            assert_eq!(request.status().as_u16(), 200);
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitwarden_attempt_budgets")
        .fetch_one(harness.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitwarden_auth_requests")
        .fetch_one(harness.db.pool())
        .await
        .unwrap();
    assert_eq!(requests, 0);
    assert_eq!(
        password(&harness.http_url, &user.email, &user.password_hash()).await,
        200
    );
}

#[tokio::test]
async fn exhausted_public_login_and_recovery_match_unknown_account_responses() {
    let harness = Harness::start_with(|mut config| {
        config.max_failed_sign_ins = 3;
        config
    })
    .await;
    let user = Account::register(
        &harness.http_url,
        "private-existence@example.test",
        "a sufficiently long password",
        LIGHT,
    )
    .await;
    for _ in 0..3 {
        assert_eq!(password(&harness.http_url, &user.email, "wrong").await, 400);
    }
    let known = password_response(&harness.http_url, &user.email, &user.password_hash()).await;
    let unknown = password_response(&harness.http_url, "ghost@example.test", "wrong").await;
    assert_eq!(known.status(), unknown.status());
    assert_eq!(
        known.json::<Value>().await.unwrap(),
        unknown.json::<Value>().await.unwrap()
    );
    let mut failures = Vec::new();
    for email in [user.email.as_str(), "ghost@example.test"] {
        let response = http().post(format!("{}/api/two-factor/recover",harness.http_url))
            .json(&json!({"email":email,"masterPasswordHash":user.password_hash(),"recoveryCode":"wrong"}))
            .send().await.unwrap();
        assert_eq!(response.status().as_u16(), 400);
        failures.push(response.json::<Value>().await.unwrap());
    }
    assert_eq!(failures[0], failures[1]);
    let attempts: i64 = sqlx::query_scalar(
        "SELECT attempts FROM bitwarden_attempt_budgets WHERE namespace='verification'",
    )
    .fetch_one(harness.db.pool())
    .await
    .unwrap();
    assert_eq!(attempts, 3);
}

#[tokio::test]
async fn unknown_accounts_cannot_take_the_last_slot_from_login_reproof_or_send() {
    let harness = Harness::start().await;
    let user = Account::register(
        &harness.http_url,
        "capacity@example.test",
        "a sufficiently long password",
        LIGHT,
    )
    .await;
    let bearer = user.access_token(&harness.http_url).await;
    let response = http()
        .post(format!("{}/api/sends", harness.http_url))
        .bearer_auth(&bearer)
        .json(
            &json!({"type":0,"name":ENC,"key":ENC,"text":{"text":ENC,"hidden":true},
            "deletionDate": (chrono::Utc::now()+chrono::Duration::days(1)).to_rfc3339(),
            "password":"send-client-hash"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let send: Value = response.json().await.unwrap();
    sqlx::query(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
        INSERT INTO bitwarden_attempt_budgets(namespace,bucket,expires_at,attempts)
        SELECT 'verification',printf('%064x',x),?,1 FROM n",
    )
    .bind(chrono::Utc::now().timestamp_millis() + 900_000)
    .execute(harness.db.pool())
    .await
    .unwrap();

    assert_eq!(
        password(&harness.http_url, "unknown-capacity@example.test", "wrong").await,
        400
    );
    assert_eq!(password(&harness.http_url,&user.email,&user.password_hash()).await,200,
        "a fabricated username must not prevent an existing credential from reserving its first budget");
    let proof = http()
        .post(format!("{}/api/accounts/verify-password", harness.http_url))
        .bearer_auth(&bearer)
        .json(&json!({"masterPasswordHash":user.password_hash()}))
        .send()
        .await
        .unwrap();
    assert_eq!(proof.status().as_u16(), 200);
    let opened = http()
        .post(format!(
            "{}/api/sends/access/{}",
            harness.http_url,
            send["accessId"].as_str().unwrap()
        ))
        .json(&json!({"password":"send-client-hash"}))
        .send()
        .await
        .unwrap();
    assert_eq!(opened.status().as_u16(), 200);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bitwarden_attempt_budgets WHERE namespace='verification'",
    )
    .fetch_one(harness.db.pool())
    .await
    .unwrap();
    assert_eq!(count, 9999);
}
