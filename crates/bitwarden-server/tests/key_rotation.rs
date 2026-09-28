//! Rotating the user key (ADR 0148 §6), in process: a rotation that leaves
//! anything behind changes nothing, and a whole one leaves a vault that
//! opens only under the new key.
mod common;

use chrono::{Duration, Utc};
use common::client::{encrypt, wrap, Account, PBKDF2};
use common::orgs::{account, Api};
use common::Harness;
use opensesame_provider_bitwarden::{EncString, MasterKey, SymmetricKey};
use rand::RngCore as _;
use serde_json::{json, Value};

struct Vault {
    folder: String,
    cipher: String,
    send: String,
    public_key: String,
}

async fn fill(account: &Account, api: &Api) -> Vault {
    let key = account.user_key();
    let folder = api
        .ok(
            "POST",
            "/folders",
            Some(json!({"name": encrypt(&key, b"Home")})),
        )
        .await;
    let cipher = api
        .ok(
            "POST",
            "/ciphers",
            Some(
                json!({"type": 2, "name": encrypt(&key, b"Router"), "folderId": folder["id"],
                        "secureNote": {"type": 0}}),
            ),
        )
        .await;
    let send = api
        .ok(
            "POST",
            "/sends",
            Some(
                json!({"type": 0, "name": encrypt(&key, b"n"), "key": encrypt(&key, b"send key"),
                        "text": {"text": encrypt(&key, b"t"), "hidden": false},
                        "deletionDate": (Utc::now() + Duration::days(3)).to_rfc3339()}),
            ),
        )
        .await;
    let keys = api.ok("GET", "/accounts/keys", None).await;
    Vault {
        folder: folder["id"].as_str().unwrap().to_owned(),
        cipher: cipher["id"].as_str().unwrap().to_owned(),
        send: send["id"].as_str().unwrap().to_owned(),
        public_key: keys["publicKey"].as_str().unwrap().to_owned(),
    }
}

/// A rotation body under `new_key`; `leave_out` drops that section's items.
fn rotation(account: &Account, vault: &Vault, new_key: &[u8], leave_out: &str) -> Value {
    let key = SymmetricKey::from_bytes(new_key).unwrap();
    let (hash, wrapped) = wrap(&account.password, &account.email, &PBKDF2, new_key);
    let take = |section: &str, item: Value| {
        if section == leave_out {
            json!([])
        } else {
            json!([item])
        }
    };
    json!({
        "oldMasterKeyAuthenticationHash": account.password_hash(),
        "accountUnlockData": {
            "masterPasswordUnlockData": {
                "kdfType": 0, "kdfIterations": 600_000, "kdfMemory": null, "kdfParallelism": null,
                "email": account.email, "masterKeyAuthenticationHash": hash,
                "masterKeyEncryptedUserKey": wrapped,
            },
            "emergencyAccessUnlockData": [],
            "organizationAccountRecoveryUnlockData": [],
        },
        "accountKeys": {
            "userKeyEncryptedAccountPrivateKey": encrypt(&key, b"private key"),
            "accountPublicKey": vault.public_key,
        },
        "accountData": {
            "ciphers": take("ciphers", json!({"id": vault.cipher, "type": 2,
                "name": encrypt(&key, b"Router"), "folderId": vault.folder, "secureNote": {"type": 0}})),
            "folders": take("folders", json!({"id": vault.folder, "name": encrypt(&key, b"Home")})),
            "sends": take("sends", json!({"id": vault.send, "type": 0, "name": encrypt(&key, b"n"),
                "key": encrypt(&key, b"send key"), "text": {"text": encrypt(&key, b"t"), "hidden": false},
                "deletionDate": (Utc::now() + Duration::days(3)).to_rfc3339()})),
        },
    })
}

const ROTATE: &str = "/accounts/key-management/rotate-user-account-keys";

#[tokio::test]
async fn a_rotation_that_leaves_anything_behind_changes_nothing() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "rotate@example.com").await;
    let vault = fill(&account, &api).await;
    let before = api.ok("GET", "/sync", None).await;
    let mut new_key = vec![0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut new_key);

    for section in ["ciphers", "folders", "sends"] {
        let (status, body) = api
            .post(ROTATE, rotation(&account, &vault, &new_key, section))
            .await;
        assert_eq!(status, 400, "{section}: {body}");
    }
    let mut wrong = rotation(&account, &vault, &new_key, "");
    wrong["oldMasterKeyAuthenticationHash"] = json!("bm90IHRoZSBoYXNo");
    assert_eq!(api.post(ROTATE, wrong).await.0, 400);
    let mut kdf = rotation(&account, &vault, &new_key, "");
    kdf["accountUnlockData"]["masterPasswordUnlockData"]["kdfIterations"] = json!(700_000);
    assert_eq!(api.post(ROTATE, kdf).await.0, 400);
    let mut pair = rotation(&account, &vault, &new_key, "");
    pair["accountKeys"]["accountPublicKey"] = json!("c29tZW9uZSBlbHNl");
    assert_eq!(api.post(ROTATE, pair).await.0, 400);

    let after = api.ok("GET", "/sync", None).await;
    assert_eq!(before["ciphers"], after["ciphers"]);
    assert_eq!(before["profile"]["key"], after["profile"]["key"]);
}

#[tokio::test]
async fn a_whole_rotation_leaves_a_vault_only_the_new_key_opens() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "rotate@example.com").await;
    let vault = fill(&account, &api).await;
    let mut new_key = vec![0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut new_key);
    api.ok(
        "POST",
        ROTATE,
        Some(rotation(&account, &vault, &new_key, "")),
    )
    .await;

    // Every session ends; the same password signs in and unwraps the new key.
    assert_eq!(api.get("/sync").await.0, 401);
    let signed_in = account.sign_in(&harness.http_url).await;
    let wrapped: EncString = signed_in["Key"].as_str().unwrap().parse().unwrap();
    let master = MasterKey::derive(account.password.as_bytes(), &account.email, &PBKDF2).unwrap();
    let opened = master.decrypt_user_key(&wrapped).unwrap();
    assert_eq!(&*opened.to_bytes(), new_key.as_slice());
    let api = Api::new(
        &harness.http_url,
        signed_in["access_token"].as_str().unwrap().to_owned(),
    );
    let sync = api.ok("GET", "/sync", None).await;
    let name: EncString = sync["ciphers"][0]["name"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(&*opened.decrypt_string(&name).unwrap(), "Router");
    assert!(account.user_key().decrypt_string(&name).is_err());
    let folder: EncString = sync["folders"][0]["name"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(&*opened.decrypt_string(&folder).unwrap(), "Home");
    let send_key: EncString = sync["sends"][0]["key"].as_str().unwrap().parse().unwrap();
    assert_eq!(&*opened.decrypt_string(&send_key).unwrap(), "send key");
}

#[tokio::test]
async fn a_rotation_carries_emergency_contacts_keys() {
    let harness = Harness::start().await;
    let (account, api) = account(&harness, "rotate@example.com").await;
    let (_, contact) = common::orgs::account(&harness, "contact@example.com").await;
    let vault = fill(&account, &api).await;
    api.ok(
        "POST",
        "/emergency-access/invite",
        Some(json!({"email": "contact@example.com", "type": 0, "waitTimeDays": 7})),
    )
    .await;
    let trusted = api.ok("GET", "/emergency-access/trusted", None).await;
    let id = trusted["data"][0]["id"].as_str().unwrap().to_owned();
    let (_, key) = api
        .get(&format!("/users/{}/public-key", contact.user_id().await))
        .await;
    let wrapped =
        common::orgs::rsa_wrap(key["publicKey"].as_str().unwrap(), account.user_key_bytes());
    api.ok(
        "POST",
        &format!("/emergency-access/{id}/confirm"),
        Some(json!({"key": wrapped})),
    )
    .await;

    let mut new_key = vec![0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut new_key);
    let body = rotation(&account, &vault, &new_key, "");
    assert_eq!(
        api.post(ROTATE, body.clone()).await.0,
        400,
        "the contact's key must be re-wrapped"
    );
    let rewrapped = common::orgs::rsa_wrap(key["publicKey"].as_str().unwrap(), &new_key);
    let mut body = body;
    body["accountUnlockData"]["emergencyAccessUnlockData"] =
        json!([{"id": id, "keyEncrypted": rewrapped}]);
    api.ok("POST", ROTATE, Some(body)).await;
}
