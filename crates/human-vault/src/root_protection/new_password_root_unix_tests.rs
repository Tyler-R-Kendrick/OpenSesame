//! Genuine Unix private first-byte root cryptographic controls, authored unexecuted.
use super::*;
use crate::root_protection::{assert_native_factor_configuration, verify_manifest_auth};
use std::{fs, os::unix::fs::MetadataExt};

#[test]
fn actual_fresh_private_key_has_password_aead_mac_and_current_native_binding() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("fresh");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    let (key, manifest) =
        init_private_versioned_key_file(&directory, b"actual private owner").unwrap();
    let ProtectionRecord::Password { wrapper, .. } = &manifest.records[0] else {
        panic!("password root required")
    };
    let recovered = crate::unwrap_vrk_with_password(b"actual private owner", wrapper).unwrap();
    assert_eq!(key.0, recovered.0);
    verify_manifest_auth(&recovered, &manifest).unwrap();
    assert_native_factor_configuration(&manifest).unwrap();
    assert!(crate::unwrap_vrk_with_password(b"wrong password", wrapper).is_err());
    assert_eq!(
        fs::metadata(root.join(super::super::KEY_FILE_NAME))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    let before = fs::read(root.join(super::super::KEY_FILE_NAME)).unwrap();
    assert!(init_private_versioned_key_file(&directory, b"second password").is_err());
    assert_eq!(
        fs::read(root.join(super::super::KEY_FILE_NAME)).unwrap(),
        before
    );
}

#[test]
fn changed_original_directory_or_invalid_password_never_receive_a_new_key() {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    let root = parent.join("fresh");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    assert!(init_private_versioned_key_file(&directory, b"").is_err());
    assert!(init_private_versioned_key_file(&directory, &[0xff]).is_err());
    let moved = parent.join("moved");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(init_private_versioned_key_file(&directory, b"actual private owner").is_err());
    assert!(!root.join(super::super::KEY_FILE_NAME).exists());
    assert!(!moved.join(super::super::KEY_FILE_NAME).exists());
}
