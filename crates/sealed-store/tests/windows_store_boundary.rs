//! Common Windows key/entry/rotation adapter contracts while trap support stays closed.
#![cfg(windows)]
use opensesame_human_vault::root_protection::RotationEdit;
use opensesame_sealed_store::{
    init_store, init_store_key, rotate_store_root, unlock_store_key, Entry,
};
use std::process::Command;

#[test]
fn windows_common_key_and_rotation_preserve_owner_and_revoke_stale_root() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let old = init_store_key(dir.path(), b"owner before rotation").unwrap();
    store
        .insert("Private/account", &Entry::parse("owner-secret\n"), &old)
        .unwrap();
    let result = rotate_store_root(
        dir.path(),
        b"owner before rotation",
        RotationEdit {
            new_password: Some(b"owner after rotation"),
            ..Default::default()
        },
    )
    .unwrap();
    let current = unlock_store_key(dir.path(), b"owner after rotation").unwrap();
    assert!(unlock_store_key(dir.path(), b"owner before rotation").is_err());
    assert!(store
        .show("Private/account", &current)
        .unwrap()
        .render()
        .contains("owner-secret"));
    assert!(store.show("Private/account", &old).is_err());
    assert!(store
        .insert("Private/stale", &Entry::parse("stale\n"), &old)
        .is_err());
    assert_eq!(result.entries, 1);
    assert!(!dir.path().join(".opensesame-rotation").exists());
}

#[test]
fn windows_junction_key_parent_cannot_touch_another_store() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    init_store(outside.path(), &[]).unwrap();
    init_store_key(outside.path(), b"outside owner").unwrap();
    let before = std::fs::read(outside.path().join(".opensesame-key")).unwrap();
    let alias = dir.path().join("alias");
    assert!(Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&alias)
        .arg(outside.path())
        .status()
        .unwrap()
        .success());
    assert!(init_store_key(&alias, b"replacement owner").is_err());
    assert!(unlock_store_key(&alias, b"outside owner").is_err());
    assert_eq!(
        std::fs::read(outside.path().join(".opensesame-key")).unwrap(),
        before
    );
    assert!(unlock_store_key(outside.path(), b"outside owner").is_ok());
}
