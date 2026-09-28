use chrono::Utc;
use opensesame_storage::bitwarden::{
    ArrivingSignIn, BitwardenArrival, BitwardenKdf, BitwardenUser,
};
use serde_json::json;

use super::*;

const ENC: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAA";

fn user() -> BitwardenUser {
    let now = Utc::now();
    BitwardenUser {
        id: "u".into(),
        email: "a@example.test".into(),
        name: None,
        master_password_hash: String::new(),
        master_password_hint: None,
        kdf: BitwardenKdf {
            kdf_type: 0,
            iterations: 600_000,
            memory: None,
            parallelism: None,
        },
        user_key: ENC.into(),
        user_key_id: None,
        public_key: None,
        private_key: None,
        security_stamp: "s".into(),
        culture: "en-US".into(),
        created_at: now,
        revision_at: now,
    }
}

fn dates() -> CipherDates {
    let now = Utc::now();
    CipherDates {
        created: now,
        revised: now,
        deleted: None,
        archived: None,
    }
}

#[test]
fn pascal_case_becomes_camel_case_all_the_way_down() {
    let legacy = json!({"Uris": [{"Uri": ENC, "Match": null}], "Password": ENC});
    assert_eq!(
        camel_deep(legacy),
        json!({"uris": [{"uri": ENC, "match": null}], "password": ENC})
    );
}

#[test]
fn a_cipher_is_checked_as_a_clients_own_write() {
    let good = json!({"type": 1, "name": ENC, "login": {"password": ENC}, "favorite": true});
    let stored = cipher("u", "c", good, dates()).unwrap();
    assert!(stored.favorite);
    assert_eq!(stored.cipher_type, 1);
    // Plaintext where ciphertext belongs is refused, not stored.
    assert!(cipher("u", "c", json!({"type": 1, "name": "plain"}), dates()).is_none());
    assert!(folder("u", "f", "plain", Utc::now(), Utc::now()).is_none());
}

#[test]
fn a_cipher_never_points_at_a_folder_that_did_not_arrive() {
    let request = |folder: &str| json!({"type": 2, "name": ENC, "secureNote": {"type": 0}, "folderId": folder});
    let mut account = BitwardenArrival {
        user: user(),
        folders: vec![folder("u", "kept", ENC, Utc::now(), Utc::now()).unwrap()],
        ciphers: vec![
            cipher("u", "a", request("kept"), dates()).unwrap(),
            cipher("u", "b", request("gone"), dates()).unwrap(),
        ],
        sign_in: ArrivingSignIn::default(),
    };
    keep_known_folders(&mut account);
    assert_eq!(account.ciphers[0].folder_id.as_deref(), Some("kept"));
    assert_eq!(account.ciphers[1].folder_id, None);
}

#[tokio::test]
async fn a_dry_run_writes_nothing_and_a_taken_email_is_left_alone() {
    let db = Db::connect_memory().await.unwrap();
    let source = Source {
        arrivals: vec![Arrival {
            account: BitwardenArrival {
                user: user(),
                folders: Vec::new(),
                ciphers: Vec::new(),
                sign_in: ArrivingSignIn::default(),
            },
            left_behind: LeftBehind::new(),
            attachments: Vec::new(),
            sends: Vec::new(),
        }],
        ..Source::default()
    };
    let dry = WriteOptions {
        dry_run: true,
        ..WriteOptions::default()
    };
    assert_eq!(
        write(&db, &source, dry).await.unwrap()[0].written,
        Written::DryRun
    );
    assert!(db
        .bitwarden_user_by_email("a@example.test")
        .await
        .unwrap()
        .is_none());

    let once = write(&db, &source, WriteOptions::default()).await.unwrap();
    assert_eq!(once[0].written, Written::Created);
    let again = write(&db, &source, WriteOptions::default()).await.unwrap();
    assert_eq!(again[0].written, Written::EmailTaken);
    let replace = WriteOptions {
        replace: true,
        ..WriteOptions::default()
    };
    assert_eq!(
        write(&db, &source, replace).await.unwrap()[0].written,
        Written::Replaced
    );
}
