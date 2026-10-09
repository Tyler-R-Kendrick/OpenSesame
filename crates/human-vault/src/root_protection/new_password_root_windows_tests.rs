//! Actual Windows private-root crypto/filesystem controls, authored unexecuted.
use super::*;
use crate::root_protection::{
    assert_native_factor_configuration, parse_key_file_json, verify_manifest_auth,
    windows_private_files::{HeldPrivateRead, PrivateDirectory},
    KeyFileContents, KEY_FILE_NAME, MAX_MANIFEST_ENCODED_BYTES,
};
use std::{fs, path::Path, sync::Arc};

#[test]
fn fresh_private_root_has_actual_password_mac_binding_and_held_key_storage() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("fresh");
    let directory = Arc::new(PrivateDirectory::create_new(&root).unwrap());
    let (item_key, manifest) =
        init_private_versioned_key_file(&directory, b"new owner password").unwrap();
    assert_native_factor_configuration(&manifest).unwrap();
    let ProtectionRecord::Password { wrapper, .. } = &manifest.records[0] else {
        panic!("password root expected")
    };
    let recovered = crate::unwrap_vrk_with_password(b"new owner password", wrapper).unwrap();
    assert_eq!(item_key.0, recovered.0);
    verify_manifest_auth(&recovered, &manifest).unwrap();
    assert!(crate::unwrap_vrk_with_password(b"wrong password", wrapper).is_err());
    let held = HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new(KEY_FILE_NAME),
        MAX_MANIFEST_ENCODED_BYTES,
    )
    .unwrap();
    let KeyFileContents::Manifest(parsed) =
        parse_key_file_json(std::str::from_utf8(held.bytes()).unwrap()).unwrap()
    else {
        panic!("manifest expected")
    };
    verify_manifest_auth(&recovered, &parsed).unwrap();
    assert_native_factor_configuration(&parsed).unwrap();
    assert!(fs::rename(root.join(KEY_FILE_NAME), root.join("moved.key")).is_err());
    let mut tampered = parsed;
    tampered.revision += 1;
    assert!(verify_manifest_auth(&recovered, &tampered).is_err());
    assert!(assert_native_factor_configuration(&tampered).is_err());
    held.validate().unwrap();
}

#[test]
fn second_initialization_never_overwrites_an_existing_current_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("fresh");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    init_private_versioned_key_file(&directory, b"original password").unwrap();
    let before = fs::read(root.join(KEY_FILE_NAME)).unwrap();
    assert!(init_private_versioned_key_file(&directory, b"different password").is_err());
    assert_eq!(fs::read(root.join(KEY_FILE_NAME)).unwrap(), before);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn invalid_native_passwords_fail_before_any_key_file_creation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("fresh");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    for password in [Vec::new(), vec![b'x'; 4097], vec![0xff]] {
        assert!(init_private_versioned_key_file(&directory, &password).is_err());
        assert!(!root.join(KEY_FILE_NAME).exists());
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}
