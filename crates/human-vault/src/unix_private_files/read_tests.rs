//! Genuine Unix filesystem controls for encrypted DATA snapshots, authored unexecuted.
use super::*;
use crate::root_protection::unix_private_files::write_new;
use std::{fs, os::unix::fs::PermissionsExt};
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("private");
    let directory = Arc::new(PrivateDirectory::create_new(&root).unwrap());
    write_new(
        &directory,
        Path::new("ciphertext"),
        b"physical encrypted DATA",
    )
    .unwrap();
    (temp, root, directory)
}
#[test]
fn actual_original_file_snapshot_refuses_in_place_rewrite_and_substituted_leaf() {
    let (_temp, root, directory) = fixture();
    let mut held = HeldPrivateRead::open(directory, Path::new("ciphertext"), 64).unwrap();
    assert_eq!(held.bytes(), b"physical encrypted DATA");
    held.validate().unwrap();
    fs::write(root.join("ciphertext"), b"changed encrypted DATA").unwrap();
    assert!(held.validate().is_err());
    fs::rename(root.join("ciphertext"), root.join("retained-original")).unwrap();
    fs::write(root.join("ciphertext"), b"physical encrypted DATA").unwrap();
    fs::set_permissions(root.join("ciphertext"), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(held.validate().is_err());
}
#[test]
fn unsafe_hardlink_symlink_broad_file_and_limits_refuse_without_repair() {
    let (_temp, root, directory) = fixture();
    for leaf in ["../ciphertext", "ciphertext/", "", "/ciphertext"] {
        assert!(HeldPrivateRead::open(Arc::clone(&directory), Path::new(leaf), 64).is_err());
    }
    for limit in [0, 1, 16 * 1024 * 1024 + 1] {
        assert!(
            HeldPrivateRead::open(Arc::clone(&directory), Path::new("ciphertext"), limit).is_err()
        );
    }
    fs::hard_link(root.join("ciphertext"), root.join("linked")).unwrap();
    assert!(HeldPrivateRead::open(Arc::clone(&directory), Path::new("ciphertext"), 64).is_err());
    fs::remove_file(root.join("linked")).unwrap();
    std::os::unix::fs::symlink("ciphertext", root.join("alias")).unwrap();
    assert!(HeldPrivateRead::open(Arc::clone(&directory), Path::new("alias"), 64).is_err());
    fs::set_permissions(root.join("ciphertext"), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(HeldPrivateRead::open(directory, Path::new("ciphertext"), 64).is_err());
    assert_eq!(
        fs::metadata(root.join("ciphertext"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}
#[test]
fn substituted_parent_never_retargets_a_retained_snapshot() {
    let (_temp, root, directory) = fixture();
    let mut held = HeldPrivateRead::open(directory, Path::new("ciphertext"), 64).unwrap();
    fs::rename(&root, root.with_extension("moved")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.join("ciphertext"), b"new owner's ciphertext").unwrap();
    assert!(held.validate().is_err());
}
