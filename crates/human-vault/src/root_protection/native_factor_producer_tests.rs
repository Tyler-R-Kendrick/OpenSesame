//! Actual native crypto/producer controls. These tests do not manufacture owner permits.
use super::*;
use crate::{unwrap_vrk_with_password, wrap_vrk_with_password};
use base64::{engine::general_purpose::STANDARD, Engine};

fn read(root: &std::path::Path) -> RootProtectionManifest {
    let KeyFileContents::Manifest(manifest) = load_key_file(root).unwrap() else {
        panic!("versioned producer fixture");
    };
    manifest
}

#[test]
fn actual_native_creation_and_authenticated_legacy_migration_emit_current_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"native creation and actual legacy password";
    let (_, manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    assert_native_factor_configuration(&manifest).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), password).unwrap();
    verify_manifest_auth(&root, &manifest).unwrap();
    let wrapper = wrap_vrk_with_password(password, &root).unwrap();
    let (migrated_root, migrated) =
        ensure_versioned_manifest(password, KeyFileContents::Legacy(wrapper)).unwrap();
    assert_eq!(migrated_root.0, root.0);
    assert_native_factor_configuration(&migrated).unwrap();
    verify_manifest_auth(&root, &migrated).unwrap();
    // The migration returns a plan. No fresh retired-owner admission is issued here.
    assert_ne!(manifest.vault_id, migrated.vault_id);
}

#[test]
fn actual_password_rewrap_recovery_add_and_remove_refresh_bindings_and_macs() {
    let dir = tempfile::tempdir().unwrap();
    let old = b"native old producer password";
    let new = b"native new producer password";
    let (_, initial) = init_versioned_key_file(dir.path(), old).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), old).unwrap();
    protect_rewrap_password(dir.path(), old, new).unwrap();
    let rewrapped = read(dir.path());
    assert_native_factor_configuration(&rewrapped).unwrap();
    assert_ne!(rewrapped.factor_configuration, initial.factor_configuration);
    assert_eq!(rewrapped.revision, initial.revision + 1);
    verify_manifest_auth(&root, &rewrapped).unwrap();
    assert!(unlock_key_file_with_password(dir.path(), old).is_err());
    assert_eq!(
        unlock_key_file_with_password(dir.path(), new).unwrap().2 .0,
        root.0
    );
    let (recovery, _) = protect_add_recovery(dir.path(), new).unwrap();
    let enrolled = read(dir.path());
    assert_native_factor_configuration(&enrolled).unwrap();
    assert_ne!(
        enrolled.factor_configuration,
        rewrapped.factor_configuration
    );
    protect_test_recovery(dir.path(), &recovery).unwrap();
    let recovery_id = enrolled
        .records
        .iter()
        .find(|record| record.kind_name() == "recovery-key")
        .unwrap()
        .protector_id();
    protect_remove(dir.path(), new, recovery_id).unwrap();
    let removed = read(dir.path());
    assert_native_factor_configuration(&removed).unwrap();
    assert_ne!(removed.factor_configuration, enrolled.factor_configuration);
    verify_manifest_auth(&root, &removed).unwrap();
    assert!(protect_test_recovery(dir.path(), &recovery).is_err());
}

#[test]
fn genuine_native_rotation_proves_the_new_root_and_refreshes_its_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"actual native producer rotation";
    let (_, initial) = init_versioned_key_file(dir.path(), password).unwrap();
    let prepared = prepare_root_rotation(dir.path(), password, RotationEdit::default(), &|_, _| {
        panic!("password-only root has no age capsule to seal")
    })
    .unwrap();
    assert_native_factor_configuration(&prepared.manifest).unwrap();
    assert_ne!(
        prepared.manifest.factor_configuration,
        initial.factor_configuration
    );
    assert_eq!(prepared.manifest.root_epoch, initial.root_epoch + 1);
    assert_eq!(prepared.manifest.revision, initial.revision + 1);
    let reopened = unwrap_vrk_with_password(
        password,
        password_wrapper_from_manifest(&prepared.manifest).unwrap(),
    )
    .unwrap();
    assert_eq!(reopened.0, prepared.new_vrk.0);
    assert_ne!(prepared.old_vrk.0, prepared.new_vrk.0);
    verify_manifest_auth(&reopened, &prepared.manifest).unwrap();
    assert!(verify_manifest_auth(&prepared.old_vrk, &prepared.manifest).is_err());
}

#[test]
fn correctly_maced_native_stale_binding_refuses_actual_unlock_and_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"actual native stale binding control";
    let (_, mut manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), password).unwrap();
    manifest.factor_configuration = Some(
        serde_json::from_value(serde_json::json!({
            "version":1,"digestB64":STANDARD.encode([7u8;32])
        }))
        .unwrap(),
    );
    seal_manifest_auth(&root, &mut manifest).unwrap();
    verify_manifest_auth(&root, &manifest).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(manifest)).unwrap();
    let before = std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    assert!(matches!(
        unlock_key_file_with_password(dir.path(), password),
        Err(ProtectionError::ContextMismatch)
    ));
    assert_eq!(
        protect_add_recovery(dir.path(), password),
        Err(ProtectionError::ContextMismatch)
    );
    assert_eq!(
        std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap(),
        before
    );
}

#[test]
fn native_generation_overflow_refuses_without_rewriting_the_current_keyfile() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"native overflow producer";
    let (_, mut manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), password).unwrap();
    manifest.revision = u64::MAX;
    manifest.factor_configuration = Some(prepare_native_factor_configuration(&manifest).unwrap());
    seal_manifest_auth(&root, &mut manifest).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(manifest.clone())).unwrap();
    let before = std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    assert_eq!(
        protect_add_recovery(dir.path(), password),
        Err(ProtectionError::ContextMismatch)
    );
    assert_eq!(
        std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap(),
        before
    );
    manifest.revision = 1;
    manifest.root_epoch = u64::MAX;
    manifest.factor_configuration = Some(prepare_native_factor_configuration(&manifest).unwrap());
    seal_manifest_auth(&root, &mut manifest).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(manifest)).unwrap();
    assert!(matches!(
        prepare_root_rotation(dir.path(), password, RotationEdit::default(), &|_, _| {
            panic!("overflow must refuse before capsule preparation")
        }),
        Err(ProtectionError::ContextMismatch)
    ));
}

#[test]
fn signed_historical_absent_binding_stays_ordinary_compatible_but_mutation_issues_one() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"native historical signed absence";
    let (_, mut manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    let (_, _, root) = unlock_key_file_with_password(dir.path(), password).unwrap();
    manifest.factor_configuration = None;
    seal_manifest_auth(&root, &mut manifest).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Manifest(manifest)).unwrap();
    unlock_key_file_with_password(dir.path(), password).unwrap();
    protect_rewrap_password(dir.path(), password, b"native upgraded password").unwrap();
    assert_native_factor_configuration(&read(dir.path())).unwrap();
    let (_, _, reopened) =
        unlock_key_file_with_password(dir.path(), b"native upgraded password").unwrap();
    assert!(
        reopened.0 == root.0,
        "rewrapping must preserve the actual prior root bytes"
    );
    assert!(unlock_key_file_with_password(dir.path(), password).is_err());
}

#[test]
fn actual_native_keyfile_reader_refuses_critical_policy_before_password_unwrap() {
    let dir = tempfile::tempdir().unwrap();
    let password = b"native actual critical policy refusal";
    let (_, manifest) = init_versioned_key_file(dir.path(), password).unwrap();
    let mut value = serde_json::to_value(manifest).unwrap();
    value["criticalExtensions"] = serde_json::json!(["unsupported-required-factor"]);
    std::fs::write(
        dir.path().join(KEY_FILE_NAME),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        unlock_key_file_with_password(dir.path(), password),
        Err(ProtectionError::UnknownCriticalField)
    ));
    assert_eq!(
        protect_add_recovery(dir.path(), password),
        Err(ProtectionError::UnknownCriticalField)
    );
}
