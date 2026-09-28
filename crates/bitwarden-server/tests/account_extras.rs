//! The rest of an account (ADR 0148 §6), in process: name and avatar,
//! equivalent domains, devices, a change of address, deleting the account,
//! and plain refusals for what this server does not do.
mod common;

use common::client::{wrap, PBKDF2};
use common::orgs::{account, Org};
use common::Harness;
use serde_json::json;

#[tokio::test]
async fn profile_avatar_and_domains_reach_the_sync() {
    let harness = Harness::start().await;
    let (_, api) = account(&harness, "me@example.com").await;
    let profile = api
        .ok("PUT", "/accounts/profile", Some(json!({"name": "  Ada  "})))
        .await;
    assert_eq!(profile["name"], "Ada");
    assert_eq!(
        api.put("/accounts/avatar", json!({"avatarColor": "red"}))
            .await
            .0,
        400
    );
    api.ok(
        "PUT",
        "/accounts/avatar",
        Some(json!({"avatarColor": "#3366ff"})),
    )
    .await;
    let domains = api
        .ok(
            "PUT",
            "/settings/domains",
            Some(
                json!({"equivalentDomains": [["example.com", "example.org"]],
                        "excludedGlobalEquivalentDomains": []}),
            ),
        )
        .await;
    assert_eq!(
        domains["equivalentDomains"],
        json!([["example.com", "example.org"]])
    );
    assert_eq!(
        api.put("/settings/domains", json!({"equivalentDomains": "nope"}))
            .await
            .0,
        400
    );
    let sync = api.ok("GET", "/sync", None).await;
    assert_eq!(sync["profile"]["name"], "Ada");
    assert_eq!(sync["profile"]["avatarColor"], "#3366ff");
    assert_eq!(sync["domains"]["equivalentDomains"][0][1], "example.org");
}

#[tokio::test]
async fn devices_are_listed_and_a_forgotten_one_cannot_refresh() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "me@example.com").await;
    let signed_in = account.sign_in(&harness.http_url).await;
    let devices = api.ok("GET", "/devices", None).await;
    let device = devices["data"][0].clone();
    assert_eq!(device["identifier"], "oracle-web-vault");
    api.ok("GET", "/devices/identifier/oracle-web-vault", None)
        .await;
    api.ok(
        "POST",
        &format!("/devices/{}/deactivate", device["id"].as_str().unwrap()),
        Some(json!({})),
    )
    .await;
    let refreshed: serde_json::Value = common::client::http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", "web"),
            (
                "refresh_token",
                signed_in["refresh_token"].as_str().unwrap(),
            ),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(refreshed.get("access_token").is_none(), "{refreshed}");
}

#[tokio::test]
async fn a_new_address_is_a_new_salt() {
    let harness = Harness::start().await;
    let (mut account, api) = account(&harness, "old@example.com").await;
    let (_, _taken) = common::orgs::account(&harness, "taken@example.com").await;
    let user_key = account.user_key_bytes().to_vec();
    let body = |email: &str| {
        let (hash, key) = wrap(&account.password, email, &PBKDF2, &user_key);
        json!({"newEmail": email, "masterPasswordHash": account.password_hash(),
               "newMasterPasswordHash": hash, "key": key, "token": "unused"})
    };
    api.ok(
        "POST",
        "/accounts/email-token",
        Some(json!({"newEmail": "new@example.com", "masterPasswordHash": account.password_hash()})),
    )
    .await;
    assert_eq!(
        api.post("/accounts/email", body("taken@example.com"))
            .await
            .0,
        400
    );
    api.ok("POST", "/accounts/email", Some(body("New@Example.com")))
        .await;

    assert_eq!(
        account.sign_in(&harness.http_url).await["error"],
        "invalid_grant"
    );
    let password = account.password.clone();
    account.now_has("new@example.com", &password, user_key);
    assert!(account.sign_in(&harness.http_url).await["access_token"].is_string());
}

#[tokio::test]
async fn an_account_is_deleted_unless_it_alone_owns_an_organization() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "me@example.com").await;
    let proof = json!({"masterPasswordHash": account.password_hash()});
    assert_eq!(
        api.delete("/accounts", json!({"masterPasswordHash": "wrong"}))
            .await
            .0,
        400
    );
    let (org, _) = Org::create(&api, "Mine").await;
    assert_eq!(api.delete("/accounts", proof.clone()).await.0, 400);
    api.ok(
        "DELETE",
        &format!("/organizations/{}", org.id),
        Some(proof.clone()),
    )
    .await;
    api.ok("DELETE", "/accounts", Some(proof)).await;
    assert_eq!(
        account.sign_in(&harness.http_url).await["error"],
        "invalid_grant"
    );
}

#[tokio::test]
async fn what_the_server_does_not_do_it_says() {
    let harness = Harness::start().await;
    let (_, api) = account(&harness, "me@example.com").await;
    let hint = common::client::http()
        .post(format!("{}/api/accounts/password-hint", harness.http_url))
        .json(&json!({"email": "me@example.com"}))
        .send()
        .await
        .unwrap();
    assert_eq!(hint.status(), 400);
    assert_eq!(
        api.get("/hibp/breach?username=me%40example.com").await.0,
        400
    );
    assert_eq!(
        api.ok("GET", "/auth-requests", None).await["data"],
        json!([])
    );
    assert_eq!(api.post("/auth-requests", json!({})).await.0, 400);
}
