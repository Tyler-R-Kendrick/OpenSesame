//! Sharing transfers both ciphertext bytes and pending reservations atomically.
mod common;

use common::client::http;
use common::orgs::{account, Api, Org};
use common::Harness;
use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

const ENC: &str = "2.aGk=|aGk=|aGk=";

async fn personal(api: &Api) -> String {
    api.ok(
        "POST",
        "/ciphers",
        Some(json!({"type": 2, "name": ENC, "secureNote": {"type": 0}})),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn file(harness: &Harness, api: &Api, cipher: &str, declared: i64, bytes: usize) -> String {
    let announced = api
        .ok(
            "POST",
            &format!("/ciphers/{cipher}/attachment/v2"),
            Some(json!({"key": ENC, "fileName": ENC, "fileSize": declared})),
        )
        .await;
    let id = announced["attachmentId"].as_str().unwrap().to_owned();
    if bytes != 0 {
        let url = announced["url"]
            .as_str()
            .unwrap()
            .replace(&harness.https_url, &harness.http_url);
        let response = http()
            .post(url)
            .bearer_auth(&api.token)
            .multipart(Form::new().part("data", Part::bytes(vec![42; bytes]).file_name(ENC)))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
    }
    id
}

async fn organization_file(
    harness: &Harness,
    api: &Api,
    org: &Org,
    collection: &str,
) -> (String, String) {
    let cipher = api
        .ok(
            "POST",
            "/ciphers/create",
            Some(
                json!({"cipher": org.login("occupied", "password"), "collectionIds": [collection]}),
            ),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let attachment = file(harness, api, &cipher, 1, 5).await;
    (cipher, attachment)
}

fn shared(org: &Org, id: &str) -> Value {
    let mut body = org.login("shared", "password");
    body["id"] = json!(id);
    body
}

async fn share(api: &Api, org: &Org, collection: &str, id: &str) -> u16 {
    api.put(
        &format!("/ciphers/{id}/share"),
        json!({"cipher": shared(org, id), "collectionIds": [collection]}),
    )
    .await
    .0
}

async fn still_personal(harness: &Harness, api: &Api, cipher: &str, attachment: &str) {
    let user = api.user_id().await;
    assert_eq!(
        harness
            .db
            .bitwarden_cipher_any(cipher)
            .await
            .unwrap()
            .unwrap()
            .user_id,
        Some(user.clone())
    );
    assert_eq!(
        harness
            .db
            .bitwarden_attachment_of(cipher, attachment)
            .await
            .unwrap()
            .unwrap()
            .user_id,
        Some(user)
    );
}

#[tokio::test]
async fn single_share_charges_actual_bytes_and_preserves_the_source_when_full() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "single-share-quota@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let (occupied, existing) = organization_file(&harness, &api, &org, &collection).await;
    let cipher = personal(&api).await;
    // One declared byte hides six ciphertext bytes in the original trigger.
    let attachment = file(&harness, &api, &cipher, 1, 6).await;
    assert_eq!(share(&api, &org, &collection, &cipher).await, 400);
    still_personal(&harness, &api, &cipher, &attachment).await;
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        5
    );
    api.ok(
        "DELETE",
        &format!("/ciphers/{occupied}/attachment/{existing}"),
        None,
    )
    .await;
    assert_eq!(share(&api, &org, &collection, &cipher).await, 200);
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        6
    );
    assert_eq!(
        harness
            .db
            .bitwarden_storage_used(&api.user_id().await)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness
            .db
            .bitwarden_blob(&attachment)
            .await
            .unwrap()
            .unwrap()
            .len(),
        6
    );
}

#[tokio::test]
async fn attachment_free_shares_remain_available_to_an_overquota_organization() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "no-file-share-quota@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let (occupied, existing) = organization_file(&harness, &api, &org, &collection).await;
    let mut legacy = harness
        .db
        .bitwarden_attachment_of(&occupied, &existing)
        .await
        .unwrap()
        .unwrap();
    legacy.id = "legacy-overquota-attachment".into();
    // Existing/imported ciphertext can exceed the quota without changing
    // what an attachment-free transfer allocates.
    assert!(harness
        .db
        .bitwarden_import_attachment(&legacy, &[42; 20])
        .await
        .unwrap());
    let cipher = personal(&api).await;
    assert_eq!(share(&api, &org, &collection, &cipher).await, 200);
    let another = personal(&api).await;
    assert_eq!(
        api.put(
            "/ciphers/share",
            json!({
                "ciphers": [shared(&org, &another)], "collectionIds": [collection],
            })
        )
        .await
        .0,
        200
    );
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        25
    );
}

#[tokio::test]
async fn bulk_share_rolls_back_every_cipher_and_counts_pending_reservations() {
    let harness = Harness::start_with(|mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "bulk-share-quota@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let (occupied, existing) = organization_file(&harness, &api, &org, &collection).await;
    let first = personal(&api).await;
    let first_attachment = file(&harness, &api, &first, 1, 3).await;
    let second = personal(&api).await;
    let pending = file(&harness, &api, &second, 4, 0).await;
    let request = json!({
        "ciphers": [shared(&org, &first), shared(&org, &second)],
        "collectionIds": [collection],
    });
    assert_eq!(api.put("/ciphers/share", request.clone()).await.0, 400);
    still_personal(&harness, &api, &first, &first_attachment).await;
    still_personal(&harness, &api, &second, &pending).await;
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        5
    );
    assert_eq!(
        harness
            .db
            .bitwarden_storage_used(&api.user_id().await)
            .await
            .unwrap(),
        7
    );
    api.ok(
        "DELETE",
        &format!("/ciphers/{occupied}/attachment/{existing}"),
        None,
    )
    .await;
    assert_eq!(api.put("/ciphers/share", request).await.0, 200);
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        7
    );
    assert_eq!(
        harness
            .db
            .bitwarden_storage_used(&api.user_id().await)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn concurrent_single_and_bulk_shares_cannot_overbook_a_file_backed_destination() {
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness::start_in_file_with(&dir.path().join("share-quota.db"), |mut config| {
        config.storage_quota_bytes = 10;
        config
    })
    .await;
    let (_, api) = account(&harness, "concurrent-share-quota@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    organization_file(&harness, &api, &org, &collection).await;
    let first = personal(&api).await;
    file(&harness, &api, &first, 1, 4).await;
    let second = personal(&api).await;
    file(&harness, &api, &second, 1, 4).await;
    let bulk = json!({"ciphers": [shared(&org, &second)], "collectionIds": [collection]});
    let (single, bulk) = tokio::join!(
        share(&api, &org, &collection, &first),
        api.put("/ciphers/share", bulk)
    );
    assert_eq!(
        [single, bulk.0]
            .iter()
            .filter(|&&status| status == 200)
            .count(),
        1
    );
    assert!([single, bulk.0]
        .iter()
        .all(|&status| status == 200 || status == 400));
    assert_eq!(
        harness
            .db
            .bitwarden_org_storage_used(&org.id)
            .await
            .unwrap(),
        9
    );
    assert_eq!(
        harness
            .db
            .bitwarden_storage_used(&api.user_id().await)
            .await
            .unwrap(),
        4
    );
}
