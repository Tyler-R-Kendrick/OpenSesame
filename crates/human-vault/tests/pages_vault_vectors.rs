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
    unwrap_with_prf, vault_seal_binding, OpenedVaultFile, VaultFileError, DEVICE_IDENTITY_KEY_PATH,
};
use serde_json::Value;
use sha2::Sha256;

mod support;

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");

/// The vectors written before ADR 0172: their items are `login`, and stay so.
const LEGACY_VECTORS: [&str; 5] = [
    "export-personal",
    "backup-personal",
    "backup-project",
    "export-legacy-unbound",
    "backup-device-identity",
];

/// The vectors added by ADR 0172, holding `account` items.
const ACCOUNT_VECTORS: [&str; 3] = [
    "export-personal-accounts",
    "backup-personal-accounts",
    "backup-project-accounts",
];

/// The vector added by ADR 0173: derived passwords, in the clear and under the OPAQUE seal.
const DERIVED_VECTORS: [&str; 1] = ["backup-personal-derived"];

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
    let mut listed = serde_json::json!({
        "tomb": opened.tomb,
        "bound": opened.bound,
        "rev": opened.rev,
        "items": opened.items.iter().map(|item| serde_json::json!({
            "id": item.id, "name": item.name, "kind": item.kind,
        })).collect::<Vec<_>>(),
    });
    // Recorded only for a vector whose body carries a concealed file.
    if !opened.concealed.is_empty() {
        listed["concealed"] = serde_json::json!(opened.concealed);
    }
    listed
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

/// Name, kind and path of every listed item: a legacy vector lists its login
/// as `.login`, an account vector lists accounts as `.account` (ADR 0172).
fn assert_listing(name: &str, opened: &OpenedVaultFile) {
    let listed: Vec<(&str, &str, &str)> = opened
        .items
        .iter()
        .map(|item| (item.name.as_str(), item.kind.as_str(), item.path.as_str()))
        .collect();
    if LEGACY_VECTORS.contains(&name) {
        let logins: Vec<_> = listed
            .iter()
            .filter(|(_, kind, _)| *kind == "login")
            .collect();
        assert_eq!(logins.len(), 1, "{name}: one legacy login");
        assert_eq!(
            std::path::Path::new(logins[0].2).extension(),
            Some(std::ffi::OsStr::new("login")),
            "{name}: {}",
            logins[0].2
        );
        assert!(
            listed.iter().all(|(_, kind, _)| *kind != "account"),
            "{name}"
        );
        return;
    }
    if DERIVED_VECTORS.contains(&name) {
        support::assert_derived_listing(name, &listed);
        return;
    }
    let label = if name.contains("project") {
        "Project"
    } else {
        "Personal"
    };
    let expected: Vec<(String, String, String)> = [
        ("plain account", "account", ".account"),
        ("peppered account", "account", ".account"),
        ("derived account", "account", ".account"),
        ("keyed account", "account", ".account"),
        ("note", "note", ".note"),
    ]
    .iter()
    .map(|(what, kind, ext)| {
        let item = format!("{label} {what}");
        let path = format!("{item}{ext}");
        (item, (*kind).to_owned(), path)
    })
    .collect();
    let listed: Vec<(String, String, String)> = listed
        .iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect();
    assert_eq!(listed, expected, "{name}");
}

#[test]
fn every_vector_opens_to_its_recorded_summary_and_lists_no_value() {
    let vectors = vectors();
    assert_eq!(
        vectors.len(),
        LEGACY_VECTORS.len() + ACCOUNT_VECTORS.len() + DERIVED_VECTORS.len(),
        "the five legacy `login` vectors, the three `account` vectors and the derived one"
    );
    for (name, file, expect) in vectors {
        let opened = open_vault_file(&file, &password()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(as_listed(&opened), expect, "{name}");
        assert!(!opened.rolled_back, "{name}: no vector is a rollback");
        assert_eq!(opened.header_rev, opened.rev, "{name}");
        for item in &opened.items {
            assert!(item.path.contains(&item.name), "{name}: {}", item.path);
            assert!(!item.path.contains('/'), "{name}: no vector has folders");
        }

        assert_listing(&name, &opened);

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
            support::string_leaves(&Value::Object(rest), &mut values);
        }
        // Nor any part of the device identity key a body carries (ADR 0160 §5).
        if let Some(key) = body.get("deviceIdentityKey") {
            support::string_leaves(key, &mut values);
        }
        if ACCOUNT_VECTORS.contains(&name.as_str()) {
            // The pepper that opens a sealed password is never listed either.
            values.push(text(&fixture(), "accountPepper"));
            support::assert_account_methods(&name, &body);
        }
        if DERIVED_VECTORS.contains(&name.as_str()) {
            values.push(text(&fixture(), "accountPepper"));
            support::assert_derived_methods(&name, &body);
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

#[test]
fn lists_the_device_identity_key_by_name_and_never_by_value() {
    let file = vector("backup-device-identity");
    let opened = open_vault_file(&file, &password()).unwrap();
    // Written by the TypeScript store (the key minted under a lock, the backup
    // file built from the sealed body); read here by the Rust reader.
    assert_eq!(opened.concealed, vec![DEVICE_IDENTITY_KEY_PATH.to_owned()]);
    assert_eq!(DEVICE_IDENTITY_KEY_PATH, "config/device-identity-key");
    assert_eq!(opened.items.len(), 2, "the key is not an item");
    assert!(opened
        .items
        .iter()
        .all(|item| !item.path.contains("device-identity")));

    let body = independent_body(&file, &opened.tomb);
    let mut secrets = Vec::new();
    support::string_leaves(&body["deviceIdentityKey"], &mut secrets);
    secrets.retain(|value| value.chars().count() >= 6);
    assert!(secrets.len() >= 3, "the key holds ids and coordinates");
    let printed = format!("{opened:?}");
    for secret in secrets {
        assert!(!printed.contains(&secret), "listed part of the key");
    }
    // The private half is in the sealed body and nowhere in the file's clear text.
    assert!(!file.contains("privateJwkJson"));
    assert!(!file.contains("device-identity"));
}

#[test]
fn a_vault_without_the_key_lists_nothing_concealed() {
    for name in ["export-personal", "backup-personal", "backup-project"] {
        let opened = open_vault_file(&vector(name), &password()).unwrap();
        assert!(opened.concealed.is_empty(), "{name}");
    }
}
