use super::*;
use crate::root_protection::{
    init_versioned_key_file, seal_manifest_auth, unlock_key_file_with_password,
    verify_manifest_auth, write_key_file, AuthenticatedLegacyGates, KeyFileContents,
};

#[test]
fn independent_native_configuration_reference_vector_is_exact() {
    let manifest = RootProtectionManifest::new_empty("vector-vault".into(), "vector-root".into());
    let actual =
        serde_json::to_value(prepare_native_factor_configuration(&manifest).unwrap()).unwrap();
    assert_eq!(
        actual,
        serde_json::json!({
            "version":1,
            "digestB64":"Jv0QbXFV5o+44oSoDoSBnT8Tf7wf65VzixCb6wjp6OY="
        })
    );
    assert!(assert_native_factor_configuration(&manifest).is_err());
}

#[test]
fn actual_native_password_aead_and_mac_do_not_make_a_stale_binding_current() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"native actual configuration owner";
    let (_, mut manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), password).unwrap();
    manifest.factor_configuration = Some(prepare_native_factor_configuration(&manifest).unwrap());
    seal_manifest_auth(&root, &mut manifest).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(manifest.clone())).unwrap();
    let (_, stored, reopened) = unlock_key_file_with_password(dir.path(), password).unwrap();
    let KeyFileContents::Manifest(stored) = stored else {
        panic!("versioned native fixture");
    };
    verify_manifest_auth(&reopened, &stored).unwrap();
    assert_native_factor_configuration(&stored).unwrap();
    let mut changed = stored.clone();
    changed.revision += 1;
    seal_manifest_auth(&root, &mut changed).unwrap();
    verify_manifest_auth(&root, &changed).unwrap();
    assert!(assert_native_factor_configuration(&changed).is_err());
    let mut gated = stored.clone();
    gated.legacy_gates = Some(AuthenticatedLegacyGates {
        totp_enrolled: true,
        email_enrolled: false,
        sms_enrolled: false,
        recovery_codes_enrolled: false,
    });
    seal_manifest_auth(&root, &mut gated).unwrap();
    verify_manifest_auth(&root, &gated).unwrap();
    assert!(assert_native_factor_configuration(&gated).is_err());
    // Recomputing metadata is not proof that this TOTP was fulfilled.
    gated.factor_configuration = Some(prepare_native_factor_configuration(&gated).unwrap());
    assert_native_factor_configuration(&gated).unwrap();
}

#[test]
fn native_configuration_changes_bind_identity_selection_epoch_records_and_gates() {
    let dir = tempfile::tempdir().unwrap();
    let (_, manifest) =
        init_versioned_key_file(dir.path(), b"native configuration changes").unwrap();
    let expected = prepare_native_factor_configuration(&manifest).unwrap();
    let mut cases = Vec::new();
    let mut changed = manifest.clone();
    changed.vault_id.push('2');
    cases.push(changed);
    let mut changed = manifest.clone();
    changed.root_key_id.push('2');
    cases.push(changed);
    let mut changed = manifest.clone();
    changed.root_epoch += 1;
    cases.push(changed);
    let mut changed = manifest.clone();
    changed.revision += 1;
    cases.push(changed);
    let mut changed = manifest.clone();
    changed.preferred_protector_id = None;
    cases.push(changed);
    let mut changed = manifest.clone();
    changed.records.clear();
    cases.push(changed);
    for changed in cases {
        assert_ne!(
            prepare_native_factor_configuration(&changed).unwrap(),
            expected
        );
    }
    let mut excluded = manifest;
    excluded.auth_b64 = Some("arbitrary public tag".into());
    excluded.factor_configuration = Some(expected.clone());
    assert_eq!(
        prepare_native_factor_configuration(&excluded).unwrap(),
        expected
    );
}

#[test]
fn oversized_configuration_is_refused_before_allocating_an_unbounded_json_projection() {
    let mut manifest = RootProtectionManifest::new_empty("v".into(), "r".into());
    manifest.vault_id = "x".repeat(MAX_MANIFEST_ENCODED_BYTES + 1);
    assert_eq!(
        prepare_native_factor_configuration(&manifest),
        Err(ProtectionError::OversizedManifest)
    );
    manifest.vault_id = "v".into();
    manifest.schema_version = 2;
    assert_eq!(
        prepare_native_factor_configuration(&manifest),
        Err(ProtectionError::UnsupportedVersion(2))
    );
}
