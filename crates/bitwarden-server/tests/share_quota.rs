//! Sharing reserves destination storage before changing any ownership.
mod common;

use common::client::encrypt;
use common::orgs::{account, Api, Org};
use common::Harness;
use serde_json::json;

async fn announce(api: &Api, org: &Org, id: &str, size: i64) {
    api.ok(
        "POST",
        &format!("/ciphers/{id}/attachment/v2"),
        Some(json!({
            "key": org.enc("key"), "fileName": org.enc("file"), "fileSize": size
        })),
    )
    .await;
}

#[tokio::test]
async fn bulk_refusal_is_atomic_and_exact_fit_single_share_succeeds() {
    let h = Harness::start_with(|mut c| {
        c.storage_quota_bytes = 10;
        c
    })
    .await;
    let (account, api) = account(&h, "share-quota@example.test").await;
    let (org, collection) = Org::create(&api, "Quota").await;
    let dest = api
        .ok(
            "POST",
            "/ciphers/create",
            Some(json!({
                "cipher": org.login("destination", "secret"), "collectionIds": [collection]
            })),
        )
        .await;
    announce(&api, &org, dest["id"].as_str().unwrap(), 4).await;
    let mut originals = Vec::new();
    let mut shares = Vec::new();
    for n in 0..2 {
        let cipher = api.ok("POST", "/ciphers", Some(json!({
            "type": 2, "name": encrypt(&account.user_key(), b"personal"), "secureNote": {"type": 0}
        }))).await;
        let id = cipher["id"].as_str().unwrap();
        announce(&api, &org, id, if n == 0 { 6 } else { 1 }).await;
        let mut shared = org.login("shared", "secret");
        shared["id"] = json!(id);
        shares.push(shared);
        originals.push(id.to_owned());
    }
    let response = api
        .put(
            "/ciphers/share",
            json!({"ciphers": shares, "collectionIds": [collection]}),
        )
        .await;
    assert_eq!(response.0, 400, "{response:?}");
    assert_eq!(h.db.bitwarden_org_storage_used(&org.id).await.unwrap(), 4);
    for id in &originals {
        let cipher = api.ok("GET", &format!("/ciphers/{id}"), None).await;
        assert!(cipher["organizationId"].is_null());
        let stored = h.db.bitwarden_cipher_any(id).await.unwrap().unwrap();
        assert_eq!(
            stored.user_id.as_deref(),
            Some(api.user_id().await.as_str())
        );
    }
    let response = api
        .put(
            &format!("/ciphers/{}/share", originals[0]),
            json!({
                "cipher": shares[0], "collectionIds": [collection]
            }),
        )
        .await;
    assert_eq!(response.0, 200, "{response:?}");
    assert_eq!(h.db.bitwarden_org_storage_used(&org.id).await.unwrap(), 10);
    let response = api
        .put(
            &format!("/ciphers/{}/share", originals[1]),
            json!({
                "cipher": shares[1], "collectionIds": [collection]
            }),
        )
        .await;
    assert_eq!(response.0, 400);
    assert!(api
        .ok("GET", &format!("/ciphers/{}", originals[1]), None)
        .await["organizationId"]
        .is_null());
}
