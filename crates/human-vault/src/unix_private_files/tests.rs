//! Genuine Unix filesystem controls, authored but not executed in this source capsule.
use super::*;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
};

#[test]
fn created_root_and_first_key_bytes_are_private_and_reopen_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("fresh");
    let held = PrivateDirectory::create_new(&root).unwrap();
    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
    write_new(&held, Path::new("key"), b"exact complete bytes").unwrap();
    assert_eq!(
        fs::metadata(root.join("key")).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read(root.join("key")).unwrap(), b"exact complete bytes");
    PrivateDirectory::open(&root).unwrap();
    assert_eq!(
        PrivateDirectory::create_new(&root).err().unwrap().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(write_new(&held, Path::new("key"), b"replacement").is_err());
    assert_eq!(fs::read(root.join("key")).unwrap(), b"exact complete bytes");
}

#[test]
fn broad_root_symlink_hardlink_and_traversal_never_receive_new_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    let root = parent.join("fresh");
    let held = PrivateDirectory::create_new(&root).unwrap();
    write_new(&held, Path::new("existing"), b"unchanged").unwrap();
    symlink("existing", root.join("alias")).unwrap();
    fs::hard_link(root.join("existing"), root.join("hardlink")).unwrap();
    for leaf in [
        "alias",
        "hardlink",
        "../outside",
        "nested/key",
        "new/",
        "./new",
    ] {
        assert!(write_new(&held, Path::new(leaf), b"should not publish").is_err());
    }
    assert!(!root.join("new").exists());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(PrivateDirectory::open(&root).is_err());
    assert!(write_new(&held, Path::new("absent"), b"should not publish").is_err());
    assert!(!root.join("absent").exists());
    assert_eq!(fs::read(root.join("existing")).unwrap(), b"unchanged");
    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o755);
}

#[test]
fn substituted_original_root_is_refused_before_any_new_publication() {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    let root = parent.join("fresh");
    let held = PrivateDirectory::create_new(&root).unwrap();
    let moved = parent.join("moved");
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    assert!(write_new(&held, Path::new("absent"), b"should not publish").is_err());
    assert!(!root.join("absent").exists());
    assert!(!moved.join("absent").exists());
}
