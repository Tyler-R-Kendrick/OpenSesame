//! Organizations and collections under the oracle (ADR 0148 §5): the
//! official `bw` lists an organization, its collections and members,
//! confirms a member (wrapping the organization key to their public key
//! itself), creates a collection, moves a personal item into the
//! organization, and a second `bw` signed in as the member decrypts it.
//!
//! The organization is created the way the web vault creates one (`bw`
//! cannot), with the key made and wrapped on the test's "device".
//! `#[ignore]`d like the other oracle suites; `pnpm test:bitwarden-oracle`
//! runs it with the pinned CLI and fails, never skips, without it.
mod common;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use common::bw::Bw;
use common::client::{Account, ARGON2ID};
use common::orgs::{Api, Org};
use common::Harness;
use serde_json::{json, Value};

const PASSWORD: &str = "correct horse battery staple";

async fn api(harness: &Harness, email: &str) -> Api {
    let account = Account::register(&harness.http_url, email, PASSWORD, ARGON2ID).await;
    Api::new(
        &harness.http_url,
        account.access_token(&harness.http_url).await,
    )
}

fn find<'a>(list: &'a Value, key: &str, value: &str) -> &'a Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|v| v[key] == value)
        .unwrap_or_else(|| panic!("no {key} = {value} in {list}"))
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_works_an_organization_end_to_end() {
    let harness = Harness::start().await;
    let owner = api(&harness, "owner@example.com").await;
    let member = api(&harness, "member@example.com").await;
    let (org, default_collection) = Org::create(&owner, "Acme").await;
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": ["member@example.com"], "type": 2, "collections": []})),
        )
        .await;

    let mut bw = Bw::new(&harness).await;
    bw.login("owner@example.com", PASSWORD).await;
    let orgs = bw.json(&["list", "organizations"]).await;
    assert_eq!(find(&orgs, "id", &org.id)["name"], "Acme");
    let collections = bw
        .json(&["list", "org-collections", "--organizationid", &org.id])
        .await;
    assert_eq!(
        find(&collections, "id", &default_collection)["name"],
        "Default collection",
        "bw decrypted the collection name with the organization key"
    );

    // bw confirms the member itself: it fetches their public key and wraps
    // the organization key to it.
    let members = bw
        .json(&["list", "org-members", "--organizationid", &org.id])
        .await;
    let member_id = find(&members, "email", "member@example.com")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(find(&members, "email", "member@example.com")["status"], 1);
    bw.ok(&[
        "confirm",
        "org-member",
        &member_id,
        "--organizationid",
        &org.id,
    ])
    .await;

    let shared = bw
        .create(
            "org-collection",
            &json!({
                "organizationId": org.id,
                "name": "Shared",
                "externalId": null,
                "groups": [],
                "users": [{"id": member_id, "readOnly": false, "hidePasswords": false, "manage": false}],
            }),
        )
        .await;
    let shared_id = shared["id"].as_str().unwrap().to_owned();
    // `create org-collection` does not add it to bw's local state; a sync does.
    bw.ok(&["sync"]).await;

    // A personal item moved into the organization, re-encrypted by bw.
    let item = bw
        .create(
            "item",
            &json!({"type": 1, "name": "Router", "login": {"username": "admin", "password": "hunter2"}}),
        )
        .await;
    let item_id = item["id"].as_str().unwrap().to_owned();
    let collections_arg = B64.encode(json!([shared_id]).to_string());
    bw.ok(&["move", &item_id, &org.id, &collections_arg]).await;
    // And one created in the organization directly.
    let direct = bw
        .create(
            "item",
            &json!({"type": 2, "name": "Wiki", "notes": "shared note", "secureNote": {"type": 0},
                    "organizationId": org.id, "collectionIds": [default_collection]}),
        )
        .await;
    let direct_id = direct["id"].as_str().unwrap().to_owned();

    // The member sees what their collection holds, decrypted, and nothing else.
    let mut member_bw = Bw::new(&harness).await;
    member_bw.login("member@example.com", PASSWORD).await;
    let seen = member_bw.json(&["get", "item", &item_id]).await;
    assert_eq!(seen["organizationId"], org.id.as_str());
    assert_eq!(seen["login"]["password"], "hunter2");
    assert_eq!(seen["collectionIds"], json!([shared_id]));
    member_bw.fails(&["get", "item", &direct_id]).await;
    let listed = member_bw
        .json(&["list", "items", "--organizationid", &org.id])
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");

    // The owner puts the note in the member's collection too.
    let both = B64.encode(json!([default_collection, shared_id]).to_string());
    bw.ok(&[
        "edit",
        "item-collections",
        &direct_id,
        &both,
        "--organizationid",
        &org.id,
    ])
    .await;
    member_bw.ok(&["sync", "--force"]).await;
    let note = member_bw.json(&["get", "item", &direct_id]).await;
    assert_eq!(note["notes"], "shared note");

    let _ = member;
    assert!(harness.unrouted().is_empty(), "{:?}", harness.unrouted());
}
