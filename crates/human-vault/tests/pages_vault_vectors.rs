//! The Rust reader over the golden Pages vault vectors (ADR 0139): the same
//! file `packages/vault-core/src/vault-file.test.ts` and the app core's
//! `vault-vectors.test.ts` open, asserting the same facts — every vector
//! opens with its password to the recorded tomb, binding, revision and items;
//! nothing listed is a field value; the wrong password, a foreign tomb and an
//! edited KDF are refused; the PIN and passkey PRF wraps open the same body.
//! A failure here is a format break, never a reason to regenerate the file.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::pages_vault::{
    open_body, open_vault_file, read_vault_file, summarize, unwrap_with_password, unwrap_with_pin,
    unwrap_with_prf, vault_seal_binding, OpenedVaultFile, VaultFileError,
};
use serde_json::Value;
use sha2::Sha256;

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");

fn fixture() -> Value {
    serde_json::from_str(VECTORS).expect("the vectors parse")
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().expect(key).to_owned()
}

fn vectors() -> Vec<(String, String, Value)> {
    let fixture = fixture();
    fixture["vectors"]
        .as_object()
        .expect("vectors")
        .iter()
        .map(|(name, vector)| (name.clone(), text(vector, "file"), vector["expect"].clone()))
        .collect()
}

fn vector(name: &str) -> String {
    text(&fixture()["vectors"][name], "file")
}

fn password() -> String {
    text(&fixture(), "password")
}

fn as_listed(opened: &OpenedVaultFile) -> Value {
    serde_json::json!({
        "tomb": opened.tomb,
        "bound": opened.bound,
        "rev": opened.rev,
        "items": opened.items.iter().map(|item| serde_json::json!({
            "id": item.id, "name": item.name, "kind": item.kind,
        })).collect::<Vec<_>>(),
    })
}

fn b64(value: &Value) -> Vec<u8> {
    STANDARD
        .decode(value.as_str().expect("base64 field"))
        .expect("base64")
}

fn aes_open(key: &[u8], blob: &Value, aad: &[u8]) -> Option<Vec<u8>> {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(
            Nonce::from_slice(&b64(&blob["ivB64"])),
            Payload {
                msg: &b64(&blob["ctB64"]),
                aad,
            },
        )
        .ok()
}

/// The body decrypted independently of the reader (PBKDF2 → wrap → body),
/// so the test can name the values the reader must never list.
fn independent_body(file: &str, tomb: &str) -> Value {
    let envelope: Value = serde_json::from_str(file).unwrap();
    let vault = if envelope["vault"].is_object() {
        &envelope["vault"]
    } else {
        &envelope
    };
    let kdf = &vault["header"]["kdf"];
    let mut kek = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(
        text(&fixture(), "passwordNfkc").as_bytes(),
        &b64(&kdf["saltB64"]),
        u32::try_from(kdf["iterations"].as_u64().unwrap()).unwrap(),
        &mut kek,
    );
    let vk = aes_open(&kek, &vault["header"]["wrap"], &[]).expect("wrap opens");
    let body = aes_open(&vk, &vault["body"], &vault_seal_binding(tomb, "body"))
        .or_else(|| aes_open(&vk, &vault["body"], &[]))
        .expect("body opens");
    serde_json::from_slice(&body).unwrap()
}

/// Every string leaf of a JSON value.
fn string_leaves(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(leaf) => out.push(leaf.clone()),
        Value::Array(rows) => rows.iter().for_each(|row| string_leaves(row, out)),
        Value::Object(map) => map.values().for_each(|row| string_leaves(row, out)),
        _ => {}
    }
}

#[test]
fn every_vector_opens_to_its_recorded_summary_and_lists_no_value() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 4, "the four golden vectors");
    for (name, file, expect) in vectors {
        let opened = open_vault_file(&file, &password()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(as_listed(&opened), expect, "{name}");
        assert!(!opened.rolled_back, "{name}: no vector is a rollback");
        assert_eq!(opened.header_rev, opened.rev, "{name}");
        for item in &opened.items {
            assert!(item.path.contains(&item.name), "{name}: {}", item.path);
            assert!(!item.path.contains('/'), "{name}: no vector has folders");
        }

        let body = independent_body(&file, &opened.tomb);
        let folders = body["folders"].as_array().map_or(0, Vec::len);
        assert_eq!(opened.folders, folders, "{name}");
        let printed = format!("{opened:?}");
        let mut values = Vec::new();
        for item in body["items"].as_array().expect("items") {
            let mut rest = item.as_object().unwrap().clone();
            for listed in ["id", "name", "kind"] {
                rest.remove(listed);
            }
            string_leaves(&Value::Object(rest), &mut values);
        }
        values.retain(|value| value.chars().count() >= 6);
        assert!(!values.is_empty(), "{name}: the vector holds values");
        for value in values {
            assert!(!printed.contains(&value), "{name}: listed a field value");
        }
    }
}

#[test]
fn normalizes_the_password_with_nfkc_before_deriving() {
    let fixture = fixture();
    assert_ne!(text(&fixture, "password"), text(&fixture, "passwordNfkc"));
    let file = read_vault_file(&vector("export-personal")).unwrap();
    assert!(unwrap_with_password(&file.header, &text(&fixture, "passwordNfkc")).is_ok());
}

#[test]
fn refuses_the_wrong_password_as_wrong_password() {
    let file = vector("backup-personal");
    assert_eq!(
        open_vault_file(&file, "not the vector password").unwrap_err(),
        VaultFileError::WrongPassword
    );
}

#[test]
fn refuses_a_body_bound_to_another_tomb() {
    let mut file = read_vault_file(&vector("backup-project")).unwrap();
    let key = unwrap_with_password(&file.header, &password()).unwrap();
    file.tomb = "personal".to_owned();
    assert!(matches!(
        open_body(&file, &key),
        Err(VaultFileError::Corrupt(_))
    ));
}

/// Replace one field of the export's header KDF.
fn with_kdf(field: &str, value: Value) -> String {
    let mut envelope: Value = serde_json::from_str(&vector("export-personal")).unwrap();
    envelope["header"]["kdf"][field] = value;
    envelope.to_string()
}

#[test]
fn refuses_an_edited_kdf_before_deriving() {
    // `u32::MAX` iterations would run for hours: returning at all proves the
    // check comes before the derivation.
    for (field, value) in [
        ("iterations", serde_json::json!(599_999)),
        ("iterations", serde_json::json!(10_000_001)),
        ("iterations", serde_json::json!(u32::MAX)),
        ("iterations", serde_json::json!(600_000.5)),
        ("iterations", serde_json::json!("600000")),
        ("saltB64", serde_json::json!("AAAA")),
        ("saltB64", serde_json::json!("not base64!")),
        ("alg", serde_json::json!("PBKDF2-SHA1")),
    ] {
        let file = read_vault_file(&with_kdf(field, value.clone())).unwrap();
        assert!(
            matches!(
                unwrap_with_password(&file.header, &password()),
                Err(VaultFileError::Corrupt(_))
            ),
            "{field} = {value}"
        );
    }
}

#[test]
fn accepts_an_integral_float_iteration_count_as_js_does() {
    let file = read_vault_file(&with_kdf("iterations", serde_json::json!(600_000.0))).unwrap();
    assert!(unwrap_with_password(&file.header, &password()).is_ok());
}

#[test]
fn reports_a_rollback_and_does_not_repair_it() {
    let mut envelope: Value = serde_json::from_str(&vector("export-personal")).unwrap();
    envelope["header"]["bodyRev"] = serde_json::json!(3);
    let opened = open_vault_file(&envelope.to_string(), &password()).unwrap();
    assert!(opened.rolled_back);
    assert_eq!((opened.rev, opened.header_rev), (Some(2), Some(3)));
    assert_eq!(opened.items.len(), 2);
}

fn project_expect() -> Value {
    fixture()["vectors"]["backup-project"]["expect"].clone()
}

#[test]
fn opens_the_project_body_through_its_pin_wrap() {
    let file = read_vault_file(&vector("backup-project")).unwrap();
    assert!(file.header.has_pin());
    let key = unwrap_with_pin(&file.header, &text(&fixture(), "pin")).unwrap();
    let body = open_body(&file, &key).unwrap();
    let opened = summarize(&file, &body, &|_| None);
    assert_eq!(as_listed(&opened), project_expect());
    assert_eq!(
        unwrap_with_pin(&file.header, "73915287").unwrap_err(),
        VaultFileError::WrongPassword
    );
    assert!(matches!(
        unwrap_with_pin(&file.header, "12345678"),
        Err(VaultFileError::Rejected(_))
    ));
    let personal = read_vault_file(&vector("export-personal")).unwrap();
    assert!(matches!(
        unwrap_with_pin(&personal.header, &text(&fixture(), "pin")),
        Err(VaultFileError::Corrupt(_))
    ));
}

#[test]
fn opens_the_project_body_through_its_passkey_prf_wrap() {
    let file = read_vault_file(&vector("backup-project")).unwrap();
    let records = file.header.passkey_records().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].credential_id_b64(), "AQEBAQEBAQEBAQEBAQEBAQ==");
    let prf = STANDARD.decode(text(&fixture(), "prfOutputB64")).unwrap();
    let key = unwrap_with_prf(&records[0], &prf).unwrap();
    let body = open_body(&file, &key).unwrap();
    assert_eq!(
        as_listed(&summarize(&file, &body, &|_| None)),
        project_expect()
    );
    let mut wrong = prf.clone();
    wrong[0] ^= 1;
    assert_eq!(
        unwrap_with_prf(&records[0], &wrong).unwrap_err(),
        VaultFileError::WrongPassword
    );
}
