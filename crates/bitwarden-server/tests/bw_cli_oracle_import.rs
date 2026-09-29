//! The importer under the oracle (ADR 0148): a vault the official `bw` wrote
//! on one server is moved by the importer, and a fresh `bw` signed in to the
//! new server with the same master password reads every item back.
//!
//! `#[ignore]`d like the other oracle suites; `pnpm test:bitwarden-oracle` runs
//! it with the pinned CLI and fails, never skips, without it.
mod common;

use common::bw::Bw;
use common::client::{Account, ARGON2ID};
use common::vaultwarden;
use common::Harness;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::import::account::{self, AccountRequest, Answer, Ask, Challenge};
use opensesame_bitwarden_server::import::{self, WriteOptions, Written};
use serde_json::json;

const PASSWORD: &str = "correct horse battery staple";

struct Never;
impl Ask for Never {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer> {
        panic!("no challenge expected, got {challenge:?}")
    }
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn a_vault_bw_wrote_moves_and_bw_reads_it_back_on_the_new_server() {
    let old = Harness::start().await;
    Account::register(&old.http_url, "mover@example.com", PASSWORD, ARGON2ID).await;
    let mut before = Bw::new(&old).await;
    before.login("mover@example.com", PASSWORD).await;
    let folder = before.create("folder", &json!({"name": "Travel"})).await;
    let folder_id = folder["id"].as_str().unwrap();
    let written = before
        .create(
            "item",
            &json!({
                "type": 1, "name": "Airline", "folderId": folder_id, "favorite": true,
                "notes": "seat 1A",
                "fields": [{"name": "pin", "value": "0042", "type": 1}],
                "login": {"username": "flyer", "password": "wings-and-a-prayer",
                          "uris": [{"match": null, "uri": "https://air.example"}]},
            }),
        )
        .await;
    before
        .create(
            "item",
            &json!({"type": 2, "name": "Passport scan", "notes": "in the safe",
                    "secureNote": {"type": 0}}),
        )
        .await;

    let source = account::read(
        &AccountRequest {
            server_url: &old.http_url,
            email: "mover@example.com",
            master_password: PASSWORD.as_bytes(),
        },
        &HashRegistry::default(),
        &mut Never,
    )
    .await
    .unwrap();
    let new = Harness::start().await;
    let report = import::write(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(report[0].written, Written::Created);
    assert_eq!((report[0].folders, report[0].ciphers), (1, 2));

    let mut after = Bw::new(&new).await;
    after.login("mover@example.com", PASSWORD).await;
    assert_eq!(
        after.ok(&["get", "password", "Airline"]).await,
        "wings-and-a-prayer"
    );
    assert_eq!(
        after.ok(&["get", "notes", "Passport scan"]).await,
        "in the safe"
    );
    let item = after.json(&["get", "item", "Airline"]).await;
    assert_eq!(item["id"], written["id"]);
    assert_eq!(item["folderId"], folder_id);
    assert_eq!(item["favorite"], true);
    assert_eq!(item["fields"][0]["value"], "0042");
    assert!(new.unrouted().is_empty(), "{:?}", new.unrouted());
}

#[tokio::test]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_signs_in_to_a_moved_vaultwarden_account_with_its_old_password() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    vaultwarden::fixture(&path).await;
    let source = import::vaultwarden::read(&path).await.unwrap();
    let new = Harness::start().await;
    import::write(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();
    import::write_shared(&new.db, &source, WriteOptions::default())
        .await
        .unwrap();

    let mut bw = Bw::new(&new).await;
    bw.login(vaultwarden::EMAIL, vaultwarden::PASSWORD).await;
    assert_eq!(bw.ok(&["get", "password", "Bank"]).await, "hunter2");
    assert_eq!(bw.ok(&["get", "username", "Bank"]).await, "alice");
    let bank = bw.json(&["get", "item", "Bank"]).await;
    assert_eq!(bank["login"]["uris"][0]["uri"], "https://bank.example");
    assert_eq!(bank["favorite"], true);
    let folders = bw.json(&["list", "folders"]).await;
    assert!(folders
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["name"] == "Money"));
    let trash = bw.json(&["list", "items", "--trash"]).await;
    assert_eq!(trash[0]["name"], "Old note");

    // The organization came with it: bw unwraps its key with the account's
    // private key and reads the collection and the shared item.
    let orgs = bw.json(&["list", "organizations"]).await;
    assert_eq!(orgs[0]["name"], "Family");
    let collections = bw
        .json(&[
            "list",
            "org-collections",
            "--organizationid",
            vaultwarden::ORG,
        ])
        .await;
    assert_eq!(collections[0]["name"], "Household");
    let shared = bw.json(&["get", "item", vaultwarden::ORG_ITEM]).await;
    assert_eq!(shared["name"], "Shared");
    assert_eq!(shared["organizationId"], vaultwarden::ORG);
    assert_eq!(shared["collectionIds"], json!([vaultwarden::COLLECTION]));
    assert_eq!(shared["favorite"], true);
    let members = bw
        .json(&["list", "org-members", "--organizationid", vaultwarden::ORG])
        .await;
    let waiting = members
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "invited@example.test")
        .unwrap();
    assert_eq!(
        waiting["status"], 0,
        "an unregistered member waits as an invitation"
    );
    assert!(new.unrouted().is_empty(), "{:?}", new.unrouted());
}
