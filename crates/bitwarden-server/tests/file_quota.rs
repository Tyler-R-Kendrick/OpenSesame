//! File quotas charge ciphertext bytes atomically without changing wire sizes.
mod common;

use chrono::{Duration, Utc};
use common::client::http;
use common::orgs::{account, Api, Org};
use common::Harness;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

const ENC: &str = "2.aGk=|aGk=|aGk=";

async fn cipher(api: &Api) -> String {
    api.ok(
        "POST",
        "/ciphers",
        Some(json!({
            "type": 2, "name": ENC, "secureNote": {"type": 0}
        })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn announce(api: &Api, cipher: Option<&str>, size: i64) -> (u16, Value) {
    match cipher {
        Some(id) => {
            api.post(
                &format!("/ciphers/{id}/attachment/v2"),
                json!({
                    "key": ENC, "fileName": ENC, "fileSize": size,
                }),
            )
            .await
        }
        None => {
            api.post(
                "/sends/file/v2",
                json!({
                    "type": 1, "name": ENC, "key": ENC, "file": {"fileName": ENC},
                    "fileLength": size,
                    "deletionDate": (Utc::now() + Duration::days(2)).to_rfc3339(),
                }),
            )
            .await
        }
    }
}

fn upload_url(harness: &Harness, body: &Value) -> String {
    body["url"]
        .as_str()
        .unwrap()
        .replace(&harness.https_url, &harness.http_url)
}

fn blob_id(body: &Value) -> &str {
    body["attachmentId"]
        .as_str()
        .or_else(|| body["sendResponse"]["file"]["id"].as_str())
        .unwrap()
}

async fn upload(api: &Api, url: &str, bytes: usize) -> u16 {
    let form = Form::new().part("data", Part::bytes(vec![42; bytes]).file_name(ENC));
    http()
        .post(url)
        .bearer_auth(&api.token)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn underdeclared_uploads_cannot_hide_bytes_and_failures_can_be_retried() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "actual@example.test").await;
    let user = api.user_id().await;
    let id = cipher(&api).await;
    for target in [Some(id.as_str()), None] {
        let (status, announced) = announce(&api, target, 1).await;
        assert_eq!(status, 200, "{announced}");
        let url = upload_url(&harness, &announced);
        // Original trigger: one declared byte, one MiB of extra ciphertext.
        assert_eq!(upload(&api, &url, 1_048_577).await, 400);
        assert!(harness
            .db
            .bitwarden_blob(blob_id(&announced))
            .await
            .unwrap()
            .is_none());
        assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 1);
        assert_eq!(upload(&api, &url, 0).await, 400);
        assert_eq!(upload(&api, &url, 1_048_578).await, 400);
        assert_eq!(upload(&api, &url, 10).await, 200);
        assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 10);
        // Both kinds share the same quota, and metadata preserves protocol size.
        assert_eq!(announce(&api, Some(&id), 1).await.0, 400);
        assert_eq!(announce(&api, None, 1).await.0, 400);
        assert_ne!(upload(&api, &url, 10).await, 200);
        let remove = match target {
            Some(id) => format!("/ciphers/{id}/attachment/{}", blob_id(&announced)),
            None => format!(
                "/sends/{}",
                announced["sendResponse"]["id"].as_str().unwrap()
            ),
        };
        assert_eq!(api.call("DELETE", &remove, None).await.0, 200);
        assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn padding_is_allowed_but_actual_file_limits_hold_for_both_upload_kinds() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 100;
        config.max_file_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "padding@example.test").await;
    let user = api.user_id().await;
    let id = cipher(&api).await;
    for target in [Some(id.as_str()), None] {
        let (status, announced) = announce(&api, target, 1).await;
        assert_eq!(status, 200);
        let url = upload_url(&harness, &announced);
        assert_eq!(upload(&api, &url, 11).await, 400);
        assert_eq!(upload(&api, &url, 5).await, 200);
        if let Some(id) = target {
            assert_eq!(
                harness
                    .db
                    .bitwarden_attachment_of(id, blob_id(&announced))
                    .await
                    .unwrap()
                    .unwrap()
                    .size,
                1
            );
        } else {
            let send = announced["sendResponse"]["id"].as_str().unwrap();
            assert_eq!(
                harness
                    .db
                    .bitwarden_send(send)
                    .await
                    .unwrap()
                    .unwrap()
                    .file_size,
                Some(1)
            );
        }
    }
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 10);
    // A smaller ciphertext releases the unused part of its reservation.
    let (_, smaller) = announce(&api, None, 10).await;
    assert_eq!(upload(&api, &upload_url(&harness, &smaller), 2).await, 200);
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 12);
}

#[tokio::test]
async fn concurrent_reservations_and_uploads_share_a_file_backed_quota() {
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness::start_in_file_with(&dir.path().join("quota.db"), |mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "race@example.test").await;
    let user = api.user_id().await;
    let id = cipher(&api).await;
    let (a, b) = tokio::join!(announce(&api, Some(&id), 6), announce(&api, None, 6));
    assert_eq!([a.0, b.0].iter().filter(|&&s| s == 200).count(), 1);
    assert!([a.0, b.0].iter().all(|&s| s == 200 || s == 400));
    let accepted = if a.0 == 200 { a.1 } else { b.1 };
    let path = if accepted.get("attachmentId").is_some() {
        format!("/ciphers/{id}/attachment/{}", blob_id(&accepted))
    } else {
        format!(
            "/sends/{}",
            accepted["sendResponse"]["id"].as_str().unwrap()
        )
    };
    assert_eq!(api.call("DELETE", &path, None).await.0, 200);
    let (_, attachment) = announce(&api, Some(&id), 1).await;
    let (_, send) = announce(&api, None, 1).await;
    let a_url = upload_url(&harness, &attachment);
    let b_url = upload_url(&harness, &send);
    let (a, b) = tokio::join!(upload(&api, &a_url, 6), upload(&api, &b_url, 6));
    assert_eq!([a, b].iter().filter(|&&s| s == 200).count(), 1);
    assert!([a, b].iter().all(|&s| s == 200 || s == 400));
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 7);
    let rejected_url = if a == 400 { &a_url } else { &b_url };
    assert_eq!(upload(&api, rejected_url, 4).await, 200);
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 10);
}

#[tokio::test]
async fn organization_files_charge_the_organization_and_rekey_cannot_grow_past_quota() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "organization-quota@example.test").await;
    let user = api.user_id().await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let body = api
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({
                "cipher": org.login("file", "password"), "collectionIds": [collection],
            })),
        )
        .await;
    let id = body["id"].as_str().unwrap();
    let (_, file) = announce(&api, Some(id), 1).await;
    let url = upload_url(&harness, &file);
    assert_eq!(upload(&api, &url, 11).await, 400);
    assert_eq!(upload(&api, &url, 10).await, 200);
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        10
    );
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 0);
    assert_eq!(announce(&api, Some(id), 1).await.0, 400);
    assert_eq!(announce(&api, None, 1).await.0, 200);

    let personal = cipher(&api).await;
    let (_, file) = announce(&api, Some(&personal), 1).await;
    let url = upload_url(&harness, &file);
    assert_eq!(upload(&api, &url, 5).await, 200);
    let share = format!(
        "{}/api/ciphers/{personal}/attachment/{}/share?organizationId={}",
        harness.http_url,
        blob_id(&file),
        org.id
    );
    let replace = |size| {
        let form = Form::new()
            .text("key", ENC)
            .part("data", Part::bytes(vec![42; size]).file_name(ENC));
        http()
            .post(&share)
            .bearer_auth(&api.token)
            .multipart(form)
            .send()
    };
    assert_eq!(replace(10).await.unwrap().status().as_u16(), 400);
    assert_eq!(
        harness
            .db
            .bitwarden_blob(blob_id(&file))
            .await
            .unwrap()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(replace(9).await.unwrap().status().as_u16(), 200);
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 10);
}

#[tokio::test]
async fn concurrent_organization_uploads_cannot_overbook_the_organization() {
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness::start_in_file_with(&dir.path().join("org-quota.db"), |mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "org-race@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let body = api
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({
                "cipher": org.login("file", "password"), "collectionIds": [collection],
            })),
        )
        .await;
    let id = body["id"].as_str().unwrap();
    let (a, b) = tokio::join!(announce(&api, Some(id), 6), announce(&api, Some(id), 6));
    assert_eq!([a.0, b.0].iter().filter(|&&s| s == 200).count(), 1);
    assert!([a.0, b.0].iter().all(|&s| s == 200 || s == 400));
    let accepted = if a.0 == 200 { a.1 } else { b.1 };
    assert_eq!(
        api.call(
            "DELETE",
            &format!("/ciphers/{id}/attachment/{}", blob_id(&accepted)),
            None
        )
        .await
        .0,
        200
    );
    let (_, a) = announce(&api, Some(id), 1).await;
    let (_, b) = announce(&api, Some(id), 1).await;
    let a_url = upload_url(&harness, &a);
    let b_url = upload_url(&harness, &b);
    let (a, b) = tokio::join!(upload(&api, &a_url, 6), upload(&api, &b_url, 6));
    assert_eq!([a, b].iter().filter(|&&s| s == 200).count(), 1);
    assert!([a, b].iter().all(|&s| s == 200 || s == 400));
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        7
    );
}

#[tokio::test]
async fn exact_accounting_does_not_prevent_send_metadata_edits_for_an_overquota_owner() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "old-accounting@example.test").await;
    let (_, pending) = announce(&api, None, 1).await;
    let id = pending["sendResponse"]["id"].as_str().unwrap();
    let mut imported = harness.db.bitwarden_send(id).await.unwrap().unwrap();
    imported.id = uuid::Uuid::new_v4().to_string();
    imported.file_id = Some("old-underdeclared-blob".into());
    imported.uploaded = true;
    // Simulate an existing undercounted file without rewriting its wire size.
    assert!(harness
        .db
        .bitwarden_import_send(&imported, Some(&[42; 20]))
        .await
        .unwrap());
    let user = api.user_id().await;
    assert_eq!(harness.db.bitwarden_storage_used(&user).await.unwrap(), 21);
    let mut edit = pending["sendResponse"].clone();
    edit["disabled"] = json!(true);
    assert_eq!(api.put(&format!("/sends/{id}"), edit).await.0, 200);
    assert_eq!(announce(&api, None, 1).await.0, 400);
    assert_eq!(upload(&api, &upload_url(&harness, &pending), 1).await, 400);
}
