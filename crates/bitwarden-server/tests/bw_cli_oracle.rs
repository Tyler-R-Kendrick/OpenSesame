//! The official Bitwarden CLI, pointed at this server, is the oracle (ADR 0141).
//!
//! Every assertion below is about what `bw` itself reports — the same commands
//! a person runs against Bitwarden's own server — and then cross-checked from
//! the other side with `OpenSesame`'s native Bitwarden client, so a value `bw`
//! wrote is read back by an independent implementation of the key schedule.
//!
//! `#[ignore]`d: `pnpm test:bitwarden-oracle` installs the pinned CLI and runs
//! these with `--ignored`. Without `OPENSESAME_BW_CLI` they fail, never skip.
mod common;

use common::bw::Bw;
use common::client::{Account, ARGON2ID};
use common::Harness;
use opensesame_provider_bitwarden::{BitwardenClient, Config, ItemKind};
use secrecy::SecretString;
use serde_json::{json, Value};

const PASSWORD: &str = "correct horse battery staple";

fn login_item(folder: &str) -> Value {
    json!({
        "type": 1,
        "name": "GitHub",
        "notes": "work account",
        "favorite": true,
        "folderId": folder,
        "fields": [{"name": "recovery", "value": "r-1234", "type": 1}],
        "login": {
            "username": "octocat",
            "password": "hunter2-but-longer",
            "totp": "JBSWY3DPEHPK3PXP",
            "uris": [{"match": null, "uri": "https://github.com"}],
        },
        "reprompt": 0,
    })
}

fn other_items() -> Vec<Value> {
    vec![
        json!({"type": 2, "name": "Recovery codes", "notes": "1111-2222\n3333-4444",
               "secureNote": {"type": 0}}),
        json!({"type": 3, "name": "Visa", "card": {"cardholderName": "Ada Lovelace",
               "brand": "Visa", "number": "4111111111111111", "expMonth": "12",
               "expYear": "2031", "code": "123"}}),
        json!({"type": 4, "name": "Passport", "identity": {"title": "Ms", "firstName": "Ada",
               "lastName": "Lovelace", "email": "ada@example.com", "passportNumber": "P123"}}),
    ]
}

async fn native_client(harness: &Harness, email: &str) -> BitwardenClient {
    let config = Config::from_server_url(&harness.http_url).unwrap();
    BitwardenClient::unlock(config, email, &SecretString::from(PASSWORD))
        .await
        .unwrap()
}

/// The ids a scenario needs to refer back to.
struct Seeded {
    folder: String,
    github: String,
    note: String,
}

async fn sign_in(harness: &Harness, alice: &Account) -> Bw {
    let mut bw = Bw::new(harness).await;
    // A wrong password is refused the way bw words a Bitwarden refusal
    // (`invalid_grant` → its own message naming the server).
    let refused = bw.fails(&["login", &alice.email, "not the password"]).await;
    assert!(refused.contains("Invalid master password"), "{refused}");

    // Sign in with a differently-cased email: the salt is normalized.
    bw.login("alice@example.com", PASSWORD).await;
    let status = bw.json(&["status"]).await;
    assert_eq!(status["status"], "unlocked");
    assert_eq!(status["userEmail"], "alice@example.com");
    assert_eq!(status["serverUrl"], harness.https_url);
    bw
}

async fn seed(bw: &Bw) -> Seeded {
    // Folders and one item of every type.
    let folder = bw.create("folder", &json!({"name": "Work"})).await;
    let folder_id = folder["id"].as_str().unwrap().to_owned();
    let github = bw.create("item", &login_item(&folder_id)).await;
    let github_id = github["id"].as_str().unwrap().to_owned();
    let mut ids = vec![github_id.clone()];
    for item in other_items() {
        ids.push(
            bw.create("item", &item).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    Seeded {
        folder: folder_id,
        github: github_id,
        note: ids[1].clone(),
    }
}

async fn read_back(bw: &Bw, seeded: &Seeded) -> Value {
    let (folder_id, github_id) = (&seeded.folder, &seeded.github);
    // What bw reads back after a fresh sync is what it wrote.
    bw.ok(&["sync", "--force"]).await;
    let items = bw.json(&["list", "items"]).await;
    assert_eq!(items.as_array().unwrap().len(), 4);
    assert_eq!(
        bw.ok(&["get", "password", "GitHub"]).await,
        "hunter2-but-longer"
    );
    assert_eq!(bw.ok(&["get", "username", "GitHub"]).await, "octocat");
    assert_eq!(
        bw.ok(&["get", "notes", "Recovery codes"]).await,
        "1111-2222\n3333-4444"
    );
    assert_eq!(bw.ok(&["get", "totp", "GitHub"]).await.len(), 6);
    let card = bw.json(&["get", "item", "Visa"]).await;
    assert_eq!(card["card"]["number"], "4111111111111111");
    let passport = bw.json(&["get", "item", "Passport"]).await;
    assert_eq!(passport["identity"]["passportNumber"], "P123");
    let fetched = bw.json(&["get", "item", github_id]).await;
    assert_eq!(fetched["folderId"], folder_id.as_str());
    assert_eq!(fetched["favorite"], true);
    assert_eq!(fetched["fields"][0]["value"], "r-1234");
    assert_eq!(fetched["login"]["uris"][0]["uri"], "https://github.com");
    let folders = bw.json(&["list", "folders"]).await;
    assert!(folders
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["name"] == "Work"));
    fetched
}

async fn edit_and_cross_check(harness: &Harness, bw: &Bw, seeded: &Seeded, fetched: &Value) {
    // An independent client — OpenSesame's own key schedule — reads the same vault.
    let mut native = native_client(harness, "alice@example.com").await;
    assert_eq!(
        native.read("Work/GitHub").await.unwrap().as_str(),
        "hunter2-but-longer"
    );
    let vault = native.vault().await.unwrap();
    assert!(vault.unreadable.is_empty(), "{:?}", vault.unreadable.len());
    assert_eq!(vault.items.len(), 4);
    assert!(vault
        .items
        .iter()
        .any(|i| i.kind == ItemKind::Card && i.name == "Visa"));

    // Edit: bw sees it, and so does the native client.
    let mut edited = fetched.clone();
    edited["login"]["password"] = json!("rotated-password-2");
    edited["name"] = json!("GitHub (work)");
    bw.edit("item", &seeded.github, &edited).await;
    assert_eq!(
        bw.ok(&["get", "password", "GitHub (work)"]).await,
        "rotated-password-2"
    );
    assert_eq!(
        native.read("Work/GitHub (work)").await.unwrap().as_str(),
        "rotated-password-2"
    );
}

async fn trash_restore_delete(bw: &Bw, note_id: &str) {
    bw.ok(&["delete", "item", note_id]).await;
    let trash = bw.json(&["list", "items", "--trash"]).await;
    assert_eq!(trash.as_array().unwrap().len(), 1);
    assert_eq!(
        bw.json(&["list", "items"]).await.as_array().unwrap().len(),
        3
    );
    bw.ok(&["restore", "item", note_id]).await;
    assert_eq!(
        bw.json(&["list", "items"]).await.as_array().unwrap().len(),
        4
    );
    bw.ok(&["delete", "item", note_id, "--permanent"]).await;
    bw.ok(&["sync", "--force"]).await;
    assert_eq!(
        bw.json(&["list", "items"]).await.as_array().unwrap().len(),
        3
    );
    assert!(bw
        .json(&["list", "items", "--trash"])
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

async fn folders_and_sessions(bw: &mut Bw, seeded: &Seeded) {
    let (folder_id, github_id) = (&seeded.folder, &seeded.github);
    // Rename, then delete, the folder; its item falls back to "no folder".
    bw.edit("folder", folder_id, &json!({"name": "Day job"}))
        .await;
    assert_eq!(
        bw.json(&["get", "folder", folder_id]).await["name"],
        "Day job"
    );
    bw.ok(&["delete", "folder", folder_id]).await;
    bw.ok(&["sync", "--force"]).await;
    assert_eq!(
        bw.json(&["get", "item", github_id]).await["folderId"],
        Value::Null
    );

    // Lock and unlock locally; log out and back in.
    bw.ok(&["lock"]).await;
    bw.session = Some(bw.ok(&["unlock", PASSWORD, "--raw"]).await);
    assert_eq!(
        bw.ok(&["get", "password", "GitHub (work)"]).await,
        "rotated-password-2"
    );
    bw.ok(&["logout"]).await;
    bw.login("alice@example.com", PASSWORD).await;
    assert_eq!(
        bw.json(&["list", "items"]).await.as_array().unwrap().len(),
        3
    );
}

async fn assert_zero_knowledge(harness: &Harness, alice: &Account) {
    // The server stored only ciphertext and an Argon2id hash of the client's hash.
    let stored = harness
        .db
        .bitwarden_user_by_email("alice@example.com")
        .await
        .unwrap()
        .unwrap();
    assert!(stored
        .master_password_hash
        .starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
    assert!(!stored.master_password_hash.contains(&alice.password_hash()));
    for cipher in harness.db.bitwarden_ciphers(&stored.id).await.unwrap() {
        for plaintext in [
            "hunter2",
            "rotated-password-2",
            "octocat",
            "4111111111111111",
            "GitHub",
        ] {
            assert!(
                !cipher.data.contains(plaintext),
                "plaintext {plaintext} reached the server"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_manages_a_personal_vault_end_to_end() {
    let harness = Harness::start().await;
    let alice = Account::register(&harness.http_url, "Alice@Example.com", PASSWORD, ARGON2ID).await;
    let mut bw = sign_in(&harness, &alice).await;
    let seeded = seed(&bw).await;
    let fetched = read_back(&bw, &seeded).await;
    edit_and_cross_check(&harness, &bw, &seeded, &fetched).await;
    trash_restore_delete(&bw, &seeded.note).await;
    folders_and_sessions(&mut bw, &seeded).await;
    assert_zero_knowledge(&harness, &alice).await;
    assert!(
        harness.unrouted().is_empty(),
        "unrouted: {:#?}",
        harness.unrouted()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the official bw CLI: pnpm test:bitwarden-oracle"]
async fn bw_import_lands_whole() {
    let harness = Harness::start().await;
    Account::register(
        &harness.http_url,
        "importer@example.com",
        PASSWORD,
        ARGON2ID,
    )
    .await;
    let mut bw = Bw::new(&harness).await;
    bw.login("importer@example.com", PASSWORD).await;

    let export = json!({
        "encrypted": false,
        "folders": [{"id": "5f0c5e2a-0000-4000-8000-000000000001", "name": "Imported"}],
        "items": [
            {"id": "5f0c5e2a-0000-4000-8000-0000000000a1", "folderId": "5f0c5e2a-0000-4000-8000-000000000001",
             "type": 1, "name": "Imported login", "favorite": false, "reprompt": 0,
             "login": {"username": "u", "password": "imported-secret", "uris": []}},
            {"id": "5f0c5e2a-0000-4000-8000-0000000000a2", "folderId": null, "type": 2,
             "name": "Imported note", "notes": "n", "favorite": false, "reprompt": 0,
             "secureNote": {"type": 0}},
        ],
    });
    let path = bw.home().join("export.json");
    std::fs::write(&path, export.to_string()).unwrap();
    bw.ok(&["import", "bitwardenjson", path.to_str().unwrap()])
        .await;
    bw.ok(&["sync", "--force"]).await;

    assert_eq!(
        bw.json(&["list", "items"]).await.as_array().unwrap().len(),
        2
    );
    assert_eq!(
        bw.ok(&["get", "password", "Imported login"]).await,
        "imported-secret"
    );
    let folder = bw.json(&["list", "folders"]).await;
    let imported = folder
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Imported")
        .expect("the imported folder exists");
    assert_eq!(
        bw.json(&["get", "item", "Imported login"]).await["folderId"],
        imported["id"]
    );
    assert!(
        harness.unrouted().is_empty(),
        "unrouted: {:#?}",
        harness.unrouted()
    );
}
