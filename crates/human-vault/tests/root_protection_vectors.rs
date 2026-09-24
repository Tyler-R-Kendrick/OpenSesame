//! Cross-language vectors shared with apps/pages protection fixtures.

use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::{
    canonicalize_to_bytes, open_root_capsule, parse_root_protection_manifest, seal_manifest_auth,
    verify_manifest_auth, ProtectionContext, ProtectionError, RootProtectionManifest, SealedBlobV1,
};
use opensesame_human_vault::VaultRootKey;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    canonicalize_utf8_hex: String,
    canonicalize_json: String,
    capsule: CapsuleVector,
    manifest_auth: ManifestAuthVector,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleVector {
    kek_hex: String,
    iv_hex: String,
    root_key_hex: String,
    context: ContextJson,
    iv_b64: String,
    ct_b64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextJson {
    vault_id: String,
    root_key_id: String,
    root_epoch: u64,
    protector_id: String,
    purpose: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAuthVector {
    root_key_hex: String,
    manifest: Value,
    auth_tag_b64: String,
}

fn load_vectors() -> Vectors {
    let raw = include_str!("fixtures/root_protection_shared_vectors.json");
    serde_json::from_str(raw).expect("shared vectors parse")
}

fn hex_decode(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn shared_canonicalize_matches_ts_fixture() {
    let v = load_vectors();
    let value: Value = serde_json::from_str(&v.canonicalize_json).unwrap();
    // Round-trip through unsorted object equivalent.
    let unsorted = serde_json::json!({"b":2,"a":1,"nested":{"z":true,"y":null}});
    let bytes = canonicalize_to_bytes(&unsorted).unwrap();
    let got = bytes.iter().fold(String::new(), |mut hex, b| {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
        hex
    });
    assert_eq!(got, v.canonicalize_utf8_hex);
    let _ = value;
}

#[test]
fn shared_capsule_open_matches_ts_fixture() {
    let v = load_vectors();
    let kek: [u8; 32] = hex_decode(&v.capsule.kek_hex).try_into().unwrap();
    let root_expected: [u8; 32] = hex_decode(&v.capsule.root_key_hex).try_into().unwrap();
    let ctx = ProtectionContext {
        vault_id: v.capsule.context.vault_id.clone(),
        root_key_id: v.capsule.context.root_key_id.clone(),
        root_epoch: v.capsule.context.root_epoch,
        protector_id: v.capsule.context.protector_id.clone(),
        purpose: v.capsule.context.purpose.clone(),
    };
    let sealed = SealedBlobV1 {
        iv_b64: v.capsule.iv_b64.clone(),
        ct_b64: v.capsule.ct_b64.clone(),
    };
    let opened = open_root_capsule(&kek, &ctx, &sealed).unwrap();
    assert_eq!(opened, root_expected);

    // KP-18: swapped vault fails closed.
    let mut swapped = ctx.clone();
    swapped.vault_id = "other".into();
    assert!(matches!(
        open_root_capsule(&kek, &swapped, &sealed),
        Err(ProtectionError::CapsuleAuthFailed | ProtectionError::ContextMismatch)
    ));
    let _ = hex_decode(&v.capsule.iv_hex);
}

#[test]
fn shared_manifest_auth_matches_ts_fixture() {
    let v = load_vectors();
    let root: [u8; 32] = hex_decode(&v.manifest_auth.root_key_hex)
        .try_into()
        .unwrap();
    let vrk = VaultRootKey(root);
    let mut manifest: RootProtectionManifest =
        serde_json::from_value(v.manifest_auth.manifest.clone()).unwrap();
    seal_manifest_auth(&vrk, &mut manifest).unwrap();
    assert_eq!(
        manifest.auth_b64.as_deref(),
        Some(v.manifest_auth.auth_tag_b64.as_str())
    );
    verify_manifest_auth(&vrk, &manifest).unwrap();

    // KP-19: tamper revision.
    manifest.revision += 1;
    assert!(matches!(
        verify_manifest_auth(&vrk, &manifest),
        Err(ProtectionError::ManifestAuthFailed)
    ));
}

#[test]
fn kp20_parser_bounds_and_duplicates() {
    let huge_records = (0..65)
        .map(|i| {
            format!(
                r#"{{"kind":"password","protectorId":"p{i}","legacy":true,"wrapper":{{"salt":"YQ==","params_m_kib":65536,"params_t":3,"params_p":1,"wrapped_vrk":"YQ==","nonce":"YQ=="}},"proofStatus":"verified"}}"#
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let oversized = format!(
        r#"{{"schemaVersion":1,"vaultId":"v","rootKeyId":"r","rootEpoch":0,"revision":0,"purpose":"human-vault-root","records":[{huge_records}]}}"#
    );
    assert!(matches!(
        parse_root_protection_manifest(&oversized),
        Err(ProtectionError::TooManyRecords)
    ));

    let dup_keys = r#"{"schemaVersion":1,"schemaVersion":2,"vaultId":"v","rootKeyId":"r","rootEpoch":0,"revision":0,"purpose":"human-vault-root","records":[]}"#;
    assert!(parse_root_protection_manifest(dup_keys).is_err());
    let _ = STANDARD.encode([1u8; 4]);
}
