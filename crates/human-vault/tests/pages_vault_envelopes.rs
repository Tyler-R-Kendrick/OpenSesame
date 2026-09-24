//! The envelope rules of vault-format-v1 §7, applied by the Rust reader
//! before any key is involved: every refusal is `Rejected`, and none of
//! these files reaches a derivation (the password is never needed).

use opensesame_human_vault::pages_vault::{
    read_vault_file, VaultFileError, VaultFileFormat, MAX_OFFLINE_BACKUP_BYTES,
};
use serde_json::{json, Value};

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");

fn vector(name: &str) -> Value {
    let fixture: Value = serde_json::from_str(VECTORS).unwrap();
    serde_json::from_str(fixture["vectors"][name]["file"].as_str().unwrap()).unwrap()
}

fn rejected(text: &str) -> bool {
    matches!(read_vault_file(text), Err(VaultFileError::Rejected(_)))
}

#[test]
fn reads_both_envelopes_to_their_tombs() {
    let export = read_vault_file(&vector("export-personal").to_string()).unwrap();
    assert_eq!(export.format, VaultFileFormat::Export);
    assert_eq!(export.format.as_str(), "opensesame-vault-export");
    assert_eq!(export.tomb, "personal");
    assert_eq!(export.header.body_rev(), Some(2));
    let backup = read_vault_file(&vector("backup-project").to_string()).unwrap();
    assert_eq!(backup.format, VaultFileFormat::OfflineBackup);
    assert_eq!(backup.tomb, "proj_vectors01");
    assert_eq!(backup.sync_blobs, 0);
    let personal = read_vault_file(&vector("backup-personal").to_string()).unwrap();
    assert_eq!(
        personal.tomb, "personal",
        "projectId null is the personal tomb"
    );
}

#[test]
fn refuses_what_is_not_a_vault_file() {
    for text in ["{}", "not json", "[]", r#"{"format":"something-else"}"#] {
        assert!(rejected(text), "{text}");
    }
}

#[test]
fn refuses_an_export_without_a_tomb_header_body_or_password_wrap() {
    let base = vector("export-personal");
    let mut cases = Vec::new();
    for field in ["tomb", "header", "body"] {
        let mut envelope = base.clone();
        envelope.as_object_mut().unwrap().remove(field);
        cases.push(envelope);
    }
    let mut empty_tomb = base.clone();
    empty_tomb["tomb"] = json!("");
    cases.push(empty_tomb);
    for field in ["wrap", "kdf"] {
        let mut no_wrap = base.clone();
        no_wrap["header"].as_object_mut().unwrap().remove(field);
        cases.push(no_wrap);
    }
    for envelope in cases {
        assert!(rejected(&envelope.to_string()), "{envelope}");
    }
}

fn backup_with(edit: impl FnOnce(&mut Value)) -> String {
    let mut envelope = vector("backup-personal");
    edit(&mut envelope);
    envelope.to_string()
}

#[test]
fn refuses_a_backup_that_breaks_a_rule() {
    let blob = json!({ "id": "b", "epoch": 1, "ciphertextB64": "AAAA" });
    let cases: Vec<(&str, String)> = vec![
        ("version", backup_with(|b| b["v"] = json!(2))),
        (
            "deployment seal",
            backup_with(|b| b["deploymentSealUsed"] = json!(true)),
        ),
        (
            "seal flag missing",
            backup_with(|b| {
                b.as_object_mut().unwrap().remove("deploymentSealUsed");
            }),
        ),
        (
            "vault missing",
            backup_with(|b| {
                b.as_object_mut().unwrap().remove("vault");
            }),
        ),
        (
            "body malformed",
            backup_with(|b| b["vault"]["body"] = json!({ "ivB64": 1 })),
        ),
        (
            "plaintext marker",
            backup_with(|b| b["vault"]["header"]["secret"] = json!("x")),
        ),
        (
            "connection key",
            backup_with(|b| b["note"] = json!("OPENSESAME_CONNECTION_KEY")),
        ),
        (
            "too many blobs",
            backup_with(|b| b["syncBlobs"] = json!(vec![blob.clone(); 4097])),
        ),
        (
            "malformed blob",
            backup_with(|b| b["syncBlobs"] = json!([{ "id": "b", "epoch": 1 }])),
        ),
    ];
    for (name, text) in cases {
        assert!(rejected(&text), "{name}");
    }
}

#[test]
fn counts_sync_blobs_without_opening_them() {
    let blob = json!({ "id": "b", "epoch": 1, "ciphertextB64": "AAAA" });
    let text = backup_with(|b| b["syncBlobs"] = json!(vec![blob; 4096]));
    assert_eq!(read_vault_file(&text).unwrap().sync_blobs, 4096);
}

#[test]
fn refuses_a_backup_over_64_mib() {
    let padding = " ".repeat(MAX_OFFLINE_BACKUP_BYTES);
    let text = format!("{}{padding}", vector("backup-personal"));
    assert!(rejected(&text));
}

#[test]
fn a_header_that_is_not_v1_or_has_no_unlock_is_corrupt() {
    let mut not_v1 = vector("backup-personal");
    not_v1["vault"]["header"]["v"] = json!(2);
    let mut no_unlock = vector("backup-personal");
    let header = no_unlock["vault"]["header"].as_object_mut().unwrap();
    header.remove("wrap");
    header.remove("kdf");
    for envelope in [not_v1, no_unlock] {
        assert!(matches!(
            read_vault_file(&envelope.to_string()),
            Err(VaultFileError::Corrupt(_))
        ));
    }
}
