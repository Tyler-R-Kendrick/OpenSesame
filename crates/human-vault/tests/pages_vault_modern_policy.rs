//! Compatibility refusal, not modern-factor admission or offline revocation.
//! The golden ciphertext and wrappers stay unchanged in these tests.

use std::cell::Cell;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use opensesame_human_vault::{
    pages_vault::{
        open_body, open_vault_file, open_vault_file_with, read_vault_file, unwrap_with_password,
        unwrap_with_pin, unwrap_with_prf, vault_seal_binding, VaultFileError,
    },
    root_protection::canonicalize_to_bytes,
};
use serde_json::{json, Value};
use sha2::Sha256;

const VECTORS: &str = include_str!("../../../spec/conformance/vault-vectors.json");
const MAC_DOMAIN: &[u8] = b"opensesame/vault/root-manifest-mac/v1";
const UNSUPPORTED: VaultFileError =
    VaultFileError::Rejected("modern root-protection admission is not supported by this reader");

fn fixture() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn vector(name: &str) -> Value {
    serde_json::from_str(fixture()["vectors"][name]["file"].as_str().unwrap()).unwrap()
}

fn header(envelope: &mut Value) -> &mut Value {
    if envelope["vault"].is_object() {
        &mut envelope["vault"]["header"]
    } else {
        &mut envelope["header"]
    }
}

fn bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap()).unwrap()
}

fn decrypt(key: &[u8], seal: &Value, aad: &[u8]) -> Vec<u8> {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(
            Nonce::from_slice(&bytes(&seal["ivB64"])),
            Payload {
                msg: &bytes(&seal["ctB64"]),
                aad,
            },
        )
        .unwrap()
}

/// Independently recover the real golden root through its parked outer wrap.
fn root(envelope: &Value) -> Vec<u8> {
    let kdf = &envelope["vault"]["header"]["kdf"];
    let mut kek = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(
        fixture()["passwordNfkc"].as_str().unwrap().as_bytes(),
        &bytes(&kdf["saltB64"]),
        u32::try_from(kdf["iterations"].as_u64().unwrap()).unwrap(),
        &mut kek,
    );
    decrypt(&kek, &envelope["vault"]["header"]["wrap"], &[])
}

/// Pages-shaped PIN-only policy authenticated with that same genuine root.
/// Signing a fixture is not enrollment or a browser authenticator ceremony.
fn pin_only_policy(envelope: &Value, root: &[u8]) -> Value {
    let pin = &envelope["vault"]["header"]["unlocks"]["pin"];
    let mut policy = json!({
        "schemaVersion": 1,
        "vaultId": "vault_native_pages_test",
        "rootKeyId": "root_native_pages_test",
        "rootEpoch": 0,
        "revision": 1,
        "purpose": "human-vault-root",
        "records": [{
            "kind": "pin", "protectorId": "pin_native_pages_test", "legacy": true,
            "saltB64": pin["kdf"]["saltB64"], "iterations": pin["kdf"]["iterations"],
            "wrap": pin["wrap"], "proofStatus": "verified"
        }],
        "legacyGates": {
            "totpEnrolled": false, "emailEnrolled": false,
            "smsEnrolled": false, "recoveryCodesEnrolled": false
        }
    });
    let mut mac_key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), root)
        .expand(MAC_DOMAIN, &mut mac_key)
        .unwrap();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&mac_key).unwrap();
    mac.update(&canonicalize_to_bytes(&policy).unwrap());
    let tag = mac.finalize().into_bytes();
    policy["authB64"] = json!(STANDARD.encode(tag));
    policy
}

#[test]
fn legacy_password_pin_and_prf_vectors_remain_readable() {
    let envelope = vector("backup-project");
    let text = envelope.to_string();
    let data = fixture();
    let password = data["password"].as_str().unwrap();
    let opened = open_vault_file(&text, password).unwrap();
    assert_eq!(opened.tomb, "proj_vectors01");
    let file = read_vault_file(&text).unwrap();
    let key = unwrap_with_password(&file.header, password).unwrap();
    assert_eq!(open_body(&file, &key).unwrap().rev, opened.rev);
    let pin = unwrap_with_pin(&file.header, data["pin"].as_str().unwrap()).unwrap();
    let body = open_body(&file, &pin).unwrap();
    assert_eq!(body.rev, opened.rev);
    let records = file.header.passkey_records().unwrap();
    assert_eq!(records.len(), 1);
    let prf = unwrap_with_prf(&records[0], &bytes(&data["prfOutputB64"])).unwrap();
    assert_eq!(open_body(&file, &prf).unwrap().rev, opened.rev);
}

#[test]
fn refuses_a_pin_only_policy_even_when_the_old_password_and_body_still_decrypt() {
    let mut envelope = vector("backup-project");
    let root = root(&envelope);
    let independent = decrypt(
        &root,
        &envelope["vault"]["body"],
        &vault_seal_binding("proj_vectors01", "body"),
    );
    let body: Value = serde_json::from_slice(&independent).unwrap();
    assert!(!body["items"].as_array().unwrap().is_empty());
    let policy = pin_only_policy(&envelope, &root);
    assert_eq!(policy["records"][0]["kind"], "pin");
    envelope["vault"]["header"]["protection"] = policy;
    let password = fixture()["password"].as_str().unwrap().to_owned();
    assert_eq!(
        open_vault_file(&envelope.to_string(), &password).unwrap_err(),
        UNSUPPORTED
    );
}

#[test]
fn every_present_modern_marker_is_refused_in_both_envelopes() {
    for name in ["export-personal", "backup-project"] {
        for marker in [
            Value::Null,
            json!(false),
            json!(0),
            json!(""),
            json!([]),
            json!({}),
        ] {
            let mut envelope = vector(name);
            header(&mut envelope)["protection"] = marker;
            assert!(
                matches!(read_vault_file(&envelope.to_string()), Err(error) if error == UNSUPPORTED)
            );
        }
    }
}

#[test]
fn refuses_before_legacy_kdf_validation_or_extension_listing() {
    let mut envelope = vector("export-personal");
    envelope["header"]["protection"] = json!({ "schemaVersion": 999 });
    envelope["header"]["kdf"]["iterations"] = json!(u32::MAX);
    let called = Cell::new(false);
    let extension = |_: &str| {
        called.set(true);
        None
    };
    assert_eq!(
        open_vault_file_with(&envelope.to_string(), "wrong", &extension).unwrap_err(),
        UNSUPPORTED
    );
    assert!(!called.get());
}

#[test]
fn decoded_marker_names_and_duplicate_null_markers_cannot_reenable_legacy_admission() {
    let text = vector("export-personal").to_string();
    let aliases = [
        r#""header":{"protection":{},"protection":null,"#,
        r#""header":{"prot\u0065ction":null,"#,
    ];
    for prefix in aliases {
        let text = text.replacen(r#""header":{"#, prefix, 1);
        assert!(matches!(read_vault_file(&text), Err(error) if error == UNSUPPORTED));
    }
}
