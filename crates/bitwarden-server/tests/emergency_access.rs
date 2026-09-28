//! Emergency access (ADR 0148 §6), in process: nothing reaches a contact
//! before the grantor confirms them and a recovery is approved — by the
//! grantor, or by the wait running out — and then only what the record
//! grants.
mod common;

use common::client::{encrypt, wrap, PBKDF2};
use common::orgs::{account, rsa_wrap, Api};
use common::Harness;
use opensesame_provider_bitwarden::{EncString, MasterKey, SymmetricKey};
use serde_json::{json, Value};

async fn contact_id(grantor: &Api, email: &str) -> String {
    let trusted = grantor.ok("GET", "/emergency-access/trusted", None).await;
    trusted["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["email"] == email)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Invite `email` with `kind`; the record's id.
async fn invite(grantor: &Api, email: &str, kind: i64) -> String {
    grantor
        .ok(
            "POST",
            "/emergency-access/invite",
            Some(json!({"email": email, "type": kind, "waitTimeDays": 7})),
        )
        .await;
    contact_id(grantor, email).await
}

/// Confirm `id`, wrapping the grantor's user key to the contact; the wrap.
async fn confirm(grantor: &Api, user_key: &[u8], grantee: &Api, id: &str) -> String {
    let (_, key) = grantor
        .get(&format!("/users/{}/public-key", grantee.user_id().await))
        .await;
    let wrapped = rsa_wrap(key["publicKey"].as_str().unwrap(), user_key);
    grantor
        .ok(
            "POST",
            &format!("/emergency-access/{id}/confirm"),
            Some(json!({"key": wrapped})),
        )
        .await;
    wrapped
}

/// Invite `email` with `kind` and confirm them with the grantor's user key.
async fn named(grantor: &Api, user_key: &[u8], grantee: &Api, email: &str, kind: i64) -> String {
    let id = invite(grantor, email, kind).await;
    confirm(grantor, user_key, grantee, &id).await;
    id
}

/// A personal-API-key sign-in: the token response.
async fn sign_in_by_key(harness: &Harness, user_id: &str, key: &str) -> Value {
    common::client::http()
        .post(format!("{}/identity/connect/token", harness.http_url))
        .form(&[
            ("grant_type", "client_credentials"),
            ("scope", "api"),
            ("client_id", &format!("user.{user_id}")),
            ("client_secret", key),
            ("deviceType", "8"),
            ("deviceIdentifier", "takeover-test"),
            ("deviceName", "cli"),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn post_status(api: &Api, path: &str) -> u16 {
    api.post(path, json!({})).await.0
}

fn status(list: &Value, id: &str) -> i64 {
    list["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap()["status"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn a_view_contact_reads_the_vault_only_once_approved() {
    let harness = Harness::start().await;
    let (grantor_account, grantor) = account(&harness, "grantor@example.com").await;
    let (_, grantee) = account(&harness, "grantee@example.com").await;
    let (_, stranger) = account(&harness, "stranger@example.com").await;
    let cipher = grantor
        .ok(
            "POST",
            "/ciphers",
            Some(
                json!({"type": 2, "name": encrypt(&grantor_account.user_key(), b"Will"),
                        "secureNote": {"type": 0}}),
            ),
        )
        .await;

    let id = invite(&grantor, "grantee@example.com", 0).await;
    let listed = grantee.ok("GET", "/emergency-access/granted", None).await;
    assert_eq!(
        status(&listed, &id),
        1,
        "an existing account is accepted at once"
    );
    // Not before confirmation.
    assert_eq!(
        post_status(&grantee, &format!("/emergency-access/{id}/initiate")).await,
        400
    );

    let wrapped = confirm(&grantor, grantor_account.user_key_bytes(), &grantee, &id).await;
    grantee
        .ok(
            "POST",
            &format!("/emergency-access/{id}/initiate"),
            Some(json!({})),
        )
        .await;
    // Initiated is not approved.
    assert_eq!(
        post_status(&grantee, &format!("/emergency-access/{id}/view")).await,
        400
    );
    grantor
        .ok(
            "POST",
            &format!("/emergency-access/{id}/approve"),
            Some(json!({})),
        )
        .await;

    let view = grantee
        .ok(
            "POST",
            &format!("/emergency-access/{id}/view"),
            Some(json!({})),
        )
        .await;
    assert_eq!(view["keyEncrypted"], wrapped.as_str());
    assert_eq!(view["ciphers"][0]["id"], cipher["id"]);
    // Only what the record grants, and only to its contact.
    assert_eq!(
        post_status(&grantee, &format!("/emergency-access/{id}/takeover")).await,
        400
    );
    assert_eq!(
        post_status(&stranger, &format!("/emergency-access/{id}/view")).await,
        404
    );
    assert_eq!(
        stranger.get(&format!("/emergency-access/{id}")).await.0,
        404
    );

    // A rejection closes it again.
    grantor
        .ok(
            "POST",
            &format!("/emergency-access/{id}/reject"),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        post_status(&grantee, &format!("/emergency-access/{id}/view")).await,
        400
    );
}

#[tokio::test]
async fn a_takeover_contact_sets_a_new_password_once_the_wait_runs_out() {
    let harness = Harness::start().await;
    let (mut grantor_account, grantor) = account(&harness, "grantor@example.com").await;
    let (_, grantee) = account(&harness, "grantee@example.com").await;
    let name = encrypt(&grantor_account.user_key(), b"Will");
    grantor
        .ok(
            "POST",
            "/ciphers",
            Some(json!({"type": 2, "name": name, "secureNote": {"type": 0}})),
        )
        .await;
    let api_key = grantor
        .ok(
            "POST",
            "/accounts/api-key",
            Some(json!({"masterPasswordHash": grantor_account.password_hash()})),
        )
        .await["apiKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = named(
        &grantor,
        grantor_account.user_key_bytes(),
        &grantee,
        "grantee@example.com",
        1,
    )
    .await;
    grantee
        .ok(
            "POST",
            &format!("/emergency-access/{id}/initiate"),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        post_status(&grantee, &format!("/emergency-access/{id}/takeover")).await,
        400
    );

    // The grantor does nothing; eight days pass.
    sqlx::query(
        "UPDATE bitwarden_emergency_access SET recovery_initiated_at = '2020-01-01T00:00:00.000Z' \
         WHERE id = ?",
    )
    .bind(&id)
    .execute(harness.db.pool())
    .await
    .unwrap();
    let listed = grantee.ok("GET", "/emergency-access/granted", None).await;
    assert_eq!(status(&listed, &id), 4, "the wait settles on read");

    let takeover = grantee
        .ok(
            "POST",
            &format!("/emergency-access/{id}/takeover"),
            Some(json!({})),
        )
        .await;
    assert_eq!(takeover["kdf"], 0);
    assert_eq!(takeover["kdfIterations"], 600_000);
    // The contact's device unwraps the user key (known here) and wraps it
    // under a new master password for the grantor's address.
    let user_key = grantor_account.user_key_bytes().to_vec();
    let (hash, key) = wrap("a new password", "grantor@example.com", &PBKDF2, &user_key);
    grantee
        .ok(
            "POST",
            &format!("/emergency-access/{id}/password"),
            Some(json!({"newMasterPasswordHash": hash, "key": key})),
        )
        .await;

    // The old password and the old API key no longer work, and the new
    // password opens the same vault.
    let grantor_id = grantee.ok("GET", "/emergency-access/granted", None).await["data"][0]
        ["grantorId"]
        .as_str()
        .unwrap()
        .to_owned();
    let by_key = sign_in_by_key(&harness, &grantor_id, &api_key).await;
    assert!(by_key.get("access_token").is_none(), "{by_key}");
    assert_eq!(
        grantor_account.sign_in(&harness.http_url).await["error"],
        "invalid_grant"
    );
    grantor_account.now_has("grantor@example.com", "a new password", user_key);
    let signed_in = grantor_account.sign_in(&harness.http_url).await;
    let wrapped: EncString = signed_in["Key"].as_str().unwrap().parse().unwrap();
    let master = MasterKey::derive(b"a new password", "grantor@example.com", &PBKDF2).unwrap();
    let opened: SymmetricKey = master.decrypt_user_key(&wrapped).unwrap();
    let api = Api::new(
        &harness.http_url,
        signed_in["access_token"].as_str().unwrap().to_owned(),
    );
    let sync = api.ok("GET", "/sync", None).await;
    let stored: EncString = sync["ciphers"][0]["name"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(&*opened.decrypt_string(&stored).unwrap(), "Will");
}

#[tokio::test]
async fn an_invitation_waits_and_either_party_can_end_it() {
    let harness = Harness::start().await;
    let (_, grantor) = account(&harness, "grantor@example.com").await;
    let (_, stranger) = account(&harness, "stranger@example.com").await;
    assert_eq!(
        grantor
            .post(
                "/emergency-access/invite",
                json!({"email": "grantor@example.com", "type": 0, "waitTimeDays": 7})
            )
            .await
            .0,
        400,
        "not oneself"
    );
    assert_eq!(
        grantor
            .post(
                "/emergency-access/invite",
                json!({"email": "later@example.com", "type": 0, "waitTimeDays": 0})
            )
            .await
            .0,
        400,
        "a wait of at least a day"
    );
    grantor
        .ok(
            "POST",
            "/emergency-access/invite",
            Some(json!({"email": "Later@Example.com", "type": 0, "waitTimeDays": 7})),
        )
        .await;
    let id = contact_id(&grantor, "later@example.com").await;
    let trusted = grantor.ok("GET", "/emergency-access/trusted", None).await;
    assert_eq!(status(&trusted, &id), 0);
    assert_eq!(
        stranger
            .delete(&format!("/emergency-access/{id}"), json!({}))
            .await
            .0,
        404
    );

    let (_, later) = account(&harness, "later@example.com").await;
    let listed = later.ok("GET", "/emergency-access/granted", None).await;
    assert_eq!(
        status(&listed, &id),
        1,
        "claimed when the address registers"
    );
    later
        .ok(
            "DELETE",
            &format!("/emergency-access/{id}"),
            Some(json!({})),
        )
        .await;
    let trusted = grantor.ok("GET", "/emergency-access/trusted", None).await;
    assert!(trusted["data"].as_array().unwrap().is_empty());
}
