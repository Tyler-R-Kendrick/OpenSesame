//! Actual Windows private descriptors, ACLs, filesystem sharing and retained root lifetime.
use super::*;
use crate::root_protection::windows_private_files::{write_new, PrivateDirectory};
use std::fs;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Arc<PrivateDirectory>) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("actual-private-read-root");
    let directory = Arc::new(PrivateDirectory::create_directories(&root).unwrap());
    write_new(
        &directory,
        Path::new("original-key"),
        b"actual-original-private-bytes",
    )
    .unwrap();
    (temporary, root, directory)
}

#[test]
fn actual_original_private_snapshot_denies_writers_replacement_and_releases_after_drop() {
    let (_temporary, root, directory) = fixture();
    let path = root.join("original-key");
    let mut snapshot = HeldPrivateRead::open(directory, Path::new("original-key"), 4096).unwrap();
    assert_eq!(snapshot.bytes(), b"actual-original-private-bytes");
    assert!(File::options().write(true).open(&path).is_err());
    assert!(fs::rename(&path, root.join("replacement-target")).is_err());
    snapshot.validate().unwrap();
    drop(snapshot);
    fs::rename(&path, root.join("replacement-target")).unwrap();
    assert!(File::options()
        .write(true)
        .open(root.join("replacement-target"))
        .is_ok());
}

#[test]
fn dropping_caller_root_cannot_release_ancestors_while_snapshot_remains_live() {
    let (temporary, root, directory) = fixture();
    let target = temporary.path().join("substituted-root");
    let mut snapshot =
        HeldPrivateRead::open(Arc::clone(&directory), Path::new("original-key"), 4096).unwrap();
    drop(directory);
    assert!(fs::rename(&root, &target).is_err());
    snapshot.validate().unwrap();
    assert_eq!(snapshot.bytes(), b"actual-original-private-bytes");
    drop(snapshot);
    fs::rename(root, target).unwrap();
}

#[test]
fn actual_private_nested_children_are_pinned_and_path_aliases_do_not_select_files() {
    let (_temporary, root, directory) = fixture();
    let nested = PrivateDirectory::create_directories(&root.join("nested")).unwrap();
    write_new(
        &nested,
        Path::new("private-value"),
        b"nested-original-bytes",
    )
    .unwrap();
    drop(nested);
    let mut snapshot = HeldPrivateRead::open(
        Arc::clone(&directory),
        Path::new("nested/private-value"),
        4096,
    )
    .unwrap();
    assert_eq!(snapshot.bytes(), b"nested-original-bytes");
    assert!(fs::rename(root.join("nested"), root.join("changed-nested")).is_err());
    snapshot.validate().unwrap();
    for rejected in [
        "../original-key",
        "nested/../original-key",
        "nested/./private-value",
        "/original-key",
        "original-key:stream",
        "NUL",
        "original-key.",
        "nested//private-value",
    ] {
        assert!(
            HeldPrivateRead::open(Arc::clone(&directory), Path::new(rejected), 4096).is_err(),
            "accepted unsafe relative name {rejected}"
        );
    }
}

#[test]
fn broad_inherited_file_and_hardlinked_original_are_refused_without_repair_or_write() {
    let (_temporary, root, directory) = fixture();
    let inherited = root.join("inherited-file");
    fs::write(&inherited, b"inherited-private-looking-bytes").unwrap();
    assert!(
        HeldPrivateRead::open(Arc::clone(&directory), Path::new("inherited-file"), 4096).is_err()
    );
    assert_eq!(
        fs::read(inherited).unwrap(),
        b"inherited-private-looking-bytes"
    );
    fs::hard_link(root.join("original-key"), root.join("hardlink-key")).unwrap();
    for name in ["original-key", "hardlink-key"] {
        assert!(HeldPrivateRead::open(Arc::clone(&directory), Path::new(name), 4096).is_err());
    }
    assert_eq!(
        fs::read(root.join("original-key")).unwrap(),
        b"actual-original-private-bytes"
    );
}

#[test]
fn selected_limits_reject_oversized_private_objects_and_do_not_hold_failed_read_handles() {
    let (_temporary, root, directory) = fixture();
    for limit in [0, 4, 16 * 1024 * 1024 + 1] {
        assert!(
            HeldPrivateRead::open(Arc::clone(&directory), Path::new("original-key"), limit)
                .is_err()
        );
    }
    assert!(File::options()
        .write(true)
        .open(root.join("original-key"))
        .is_ok());
    let mut snapshot = HeldPrivateRead::open(directory, Path::new("original-key"), 4096).unwrap();
    snapshot.validate().unwrap();
}
