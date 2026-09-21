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
