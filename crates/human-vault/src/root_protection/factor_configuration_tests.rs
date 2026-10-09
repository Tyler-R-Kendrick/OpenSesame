use super::{
    encode_key_file, init_versioned_key_file, parse_key_file_json, parse_root_protection_manifest,
    seal_manifest_auth, unlock_key_file_with_password, verify_manifest_auth, write_key_file,
    FactorConfigurationBinding, KeyFileContents, ProtectionError, RootProtectionManifest,
};
use crate::VaultRootKey;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

fn binding() -> FactorConfigurationBinding {
    serde_json::from_value(json!({"version":1,"digestB64":STANDARD.encode([7_u8;32])})).unwrap()
}
#[test]
fn genuine_native_password_root_mac_retains_the_optional_binding() {
    let dir = tempfile::tempdir().unwrap();
    let (_, mut manifest) = init_versioned_key_file(dir.path(), b"binding-native-owner").unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), b"binding-native-owner").unwrap();
    verify_manifest_auth(&root, &manifest).unwrap();
    assert_eq!(
        manifest.factor_configuration,
        Some(super::prepare_native_factor_configuration(&manifest).unwrap())
    );
    // Actual native producer metadata is covered by this real root MAC; no owner permit results.
    seal_manifest_auth(&root, &mut manifest).unwrap();
    let raw = encode_key_file(&KeyFileContents::Manifest(manifest.clone())).unwrap();
    let parsed = parse_root_protection_manifest(&raw).unwrap();
    assert_eq!(parsed, manifest);
    assert!(serde_json::to_value(&parsed)
        .unwrap()
        .get("factorConfiguration")
        .is_some());
    verify_manifest_auth(&root, &parsed).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(parsed.clone())).unwrap();
    let (_, stored, stored_root) =
        unlock_key_file_with_password(dir.path(), b"binding-native-owner").unwrap();
    assert!(matches!(stored, KeyFileContents::Manifest(ref value) if value == &parsed));
    verify_manifest_auth(&stored_root, &parsed).unwrap();
    let mut removed = parsed.clone();
    removed.factor_configuration = None;
    assert_eq!(
        verify_manifest_auth(&root, &removed),
        Err(ProtectionError::ManifestAuthFailed)
    );
    let mut replaced = serde_json::to_value(parsed).unwrap();
    replaced["factorConfiguration"]["digestB64"] = json!(STANDARD.encode([8_u8; 32]));
    let replaced = parse_root_protection_manifest(&replaced.to_string()).unwrap();
    assert_eq!(
        verify_manifest_auth(&root, &replaced),
        Err(ProtectionError::ManifestAuthFailed)
    );
}
#[test]
fn absent_legacy_field_keeps_the_existing_mac_and_wire_unchanged() {
    let root = VaultRootKey([17; 32]);
    let mut manifest =
        RootProtectionManifest::new_empty("vector-vault".into(), "vector-root".into());
    seal_manifest_auth(&root, &mut manifest).unwrap();
    let before = serde_json::to_string(&manifest).unwrap();
    assert!(!before.contains("factorConfiguration"));
    let parsed = parse_root_protection_manifest(&before).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), before);
    verify_manifest_auth(&root, &parsed).unwrap();
}
#[test]
fn present_malformed_binding_refuses_instead_of_becoming_absent() {
    let base =
        serde_json::to_value(RootProtectionManifest::new_empty("v".into(), "r".into())).unwrap();
    for invalid in [
        Value::Null,
        json!({}),
        json!({"version":2,"digestB64":STANDARD.encode([7_u8;32])}),
        json!({"version":1,"digestB64":"A".repeat(42)+"B="}),
        json!({"version":1,"digestB64":"A".repeat(43)}),
        json!({"version":1,"digestB64":"A".repeat(44)}),
        json!({"version":1,"digestB64":"A".repeat(48)}),
        json!({"version":1,"digestB64":STANDARD.encode([7_u8;32]),"ownerPermit":true}),
    ] {
        let mut raw = base.clone();
        raw["factorConfiguration"] = invalid;
        assert!(serde_json::from_value::<RootProtectionManifest>(raw.clone()).is_err());
        assert!(parse_root_protection_manifest(&raw.to_string()).is_err());
    }
}
#[test]
fn decoded_binding_aliases_are_not_lost_through_a_value_projection() {
    let mut manifest = RootProtectionManifest::new_empty("v".into(), "r".into());
    manifest.factor_configuration = Some(binding());
    let raw = serde_json::to_string(&manifest).unwrap();
    let digest = format!("\"digestB64\":\"{}\"", STANDARD.encode([7_u8; 32]));
    for changed in [
        raw.replace("\"version\":1", r#""version":1,"\u0076ersion":1"#),
        raw.replace(
            &digest,
            &format!(
                "{digest},\"digest\\u004264\":\"{}\"",
                STANDARD.encode([7_u8; 32])
            ),
        ),
        raw.replace("\"version\":1", "\"version\":1.0000000000000001"),
    ] {
        assert_ne!(changed, raw);
        assert!(parse_root_protection_manifest(&changed).is_err());
        assert!(parse_key_file_json(&changed).is_err());
    }
}
