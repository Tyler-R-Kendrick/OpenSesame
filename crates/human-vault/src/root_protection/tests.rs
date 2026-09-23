use crate::password_wrap::wrap_vrk_with_password;
use crate::VaultRootKey;

use super::*;

#[test]
fn legacy_password_wrapper_round_trip_kp03() {
    let dir = tempfile::tempdir().unwrap();
    let vrk = VaultRootKey::generate();
    let wrapper = wrap_vrk_with_password(b"correct horse", &vrk).unwrap();
    write_key_file(dir.path(), &KeyFileContents::Legacy(wrapper)).unwrap();
    let (idk, contents, unlocked) =
        unlock_key_file_with_password(dir.path(), b"correct horse").unwrap();
    assert!(matches!(contents, KeyFileContents::Legacy(_)));
    assert_eq!(idk.0, unlocked.0);
    assert_eq!(idk.0, vrk.0);
    assert!(unlock_key_file_with_password(dir.path(), b"wrong").is_err());
}

#[test]
fn versioned_manifest_auth_and_list() {
    let dir = tempfile::tempdir().unwrap();
    let (idk, manifest) = init_versioned_key_file(dir.path(), b"correct horse").unwrap();
    assert_eq!(manifest.schema_version, MANIFEST_SCHEMA_VERSION);
    let (unlocked, _, vrk) = unlock_key_file_with_password(dir.path(), b"correct horse").unwrap();
    assert_eq!(unlocked.0, idk.0);
    assert_eq!(vrk.0, idk.0);
    let listed = protect_list(dir.path()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, "password");
}

#[test]
fn recovery_add_and_test() {
    let dir = tempfile::tempdir().unwrap();
    init_versioned_key_file(dir.path(), b"pw").unwrap();
    let (recovery, fp) = protect_add_recovery(dir.path(), b"pw").unwrap();
    assert!(!fp.is_empty());
    protect_test_recovery(dir.path(), &recovery).unwrap();
    let mut bad = recovery;
    bad[0] ^= 1;
    assert!(protect_test_recovery(dir.path(), &bad).is_err());
}

#[test]
fn malformed_legacy_reports_precise_error() {
    let err = parse_legacy_password_wrapper(r#"{"salt":"x"}"#).unwrap_err();
    assert!(matches!(err, ProtectionError::MalformedLegacy(_)));
}

fn only_password_id(root: &std::path::Path) -> String {
    protect_list(root)
        .unwrap()
        .into_iter()
        .find(|p| p.kind == "password")
        .unwrap()
        .protector_id
}

/// A recovery key is only ever tested natively — no unlock path reads it — so
/// the last password record is the last way in, recovery key or not.
#[test]
fn last_password_is_kept_even_beside_a_recovery_key() {
    let dir = tempfile::tempdir().unwrap();
    init_versioned_key_file(dir.path(), b"pw").unwrap();
    protect_add_recovery(dir.path(), b"pw").unwrap();
    let password_id = only_password_id(dir.path());
    let err = protect_remove(dir.path(), b"pw", &password_id).unwrap_err();
    assert_eq!(err, ProtectionError::LastVerifiedPath);
    let unlock_edit = RotationEdit {
        remove_protector: Some(&password_id),
        ..RotationEdit::default()
    };
    let no_age = |_: &VaultRootKey, _: &[String]| Err(ProtectionError::Crypto);
    let err = prepare_root_rotation(dir.path(), b"pw", unlock_edit, &no_age).err();
    assert_eq!(err, Some(ProtectionError::LastVerifiedPath));
    unlock_key_file_with_password(dir.path(), b"pw").unwrap();
}

#[test]
fn rotation_plan_rewraps_under_a_new_root_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (old_idk, _) = init_versioned_key_file(dir.path(), b"pw").unwrap();
    let before = std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap();
    let no_age = |_: &VaultRootKey, _: &[String]| Err(ProtectionError::Crypto);
    let edit = RotationEdit {
        new_password: Some(b"next"),
        ..RotationEdit::default()
    };
    let plan = prepare_root_rotation(dir.path(), b"pw", edit, &no_age).unwrap();
    assert_eq!(plan.old_vrk.0, old_idk.0);
    assert_ne!(plan.new_vrk.0, old_idk.0);
    assert_eq!(plan.manifest.root_epoch, 2);
    assert_eq!(
        std::fs::read(dir.path().join(KEY_FILE_NAME)).unwrap(),
        before
    );
    verify_manifest_auth(&plan.new_vrk, &plan.manifest).unwrap();
    assert!(verify_manifest_auth(&plan.old_vrk, &plan.manifest).is_err());
}
