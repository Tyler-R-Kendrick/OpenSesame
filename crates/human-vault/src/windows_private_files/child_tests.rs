//! Genuine Windows physical controls; authored, not executed in this Linux workspace.
use super::*;
use crate::root_protection::windows_private_files::{write_new, HeldPrivateRead};
use std::{fs, path::PathBuf, sync::Arc};

fn private_root() -> (tempfile::TempDir, PathBuf, PrivateDirectory) {
    let temp = tempfile::tempdir().unwrap();
    let opened = handles::directory(temp.path()).unwrap();
    let final_path = handles::final_path(&opened).unwrap();
    let root = PathBuf::from(final_path.strip_prefix(r"\\?\").unwrap()).join("private");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    (temp, root, directory)
}

#[test]
fn nested_children_retain_original_root_and_private_acl_after_parent_object_drop() {
    let (_temp, root, parent) = private_root();
    let first = parent.create_child(Path::new("folder")).unwrap();
    let child = Arc::new(first.create_child(Path::new("deeper")).unwrap());
    let identity = handles::identity(child.root_handle().unwrap(), true).unwrap();
    drop(first);
    drop(parent);
    child.validate_original().unwrap();
    write_new(&child, Path::new("entry.bin"), b"held child ciphertext").unwrap();
    let mut read = HeldPrivateRead::open(Arc::clone(&child), Path::new("entry.bin"), 128).unwrap();
    assert_eq!(read.bytes(), b"held child ciphertext");
    read.validate().unwrap();
    assert!(fs::rename(&root, root.with_file_name("changed")).is_err());
    assert!(fs::rename(root.join("folder"), root.join("changed-folder")).is_err());
    assert_eq!(
        handles::identity(child.root_handle().unwrap(), true).unwrap(),
        identity
    );
    security::verify(
        child.root_handle().unwrap(),
        &security::owner_sid().unwrap(),
        true,
    )
    .unwrap();
}

#[test]
fn existing_private_children_are_reused_without_repair_or_replacement() {
    let (_temp, _root, parent) = private_root();
    let original = parent.create_child(Path::new("existing")).unwrap();
    write_new(&original, Path::new("retained.bin"), b"original contents").unwrap();
    let before = handles::identity(original.root_handle().unwrap(), true).unwrap();
    let reopened = parent.create_child(Path::new("existing")).unwrap();
    assert_eq!(
        handles::identity(reopened.root_handle().unwrap(), true).unwrap(),
        before
    );
    let read = HeldPrivateRead::open(Arc::new(reopened), Path::new("retained.bin"), 128).unwrap();
    assert_eq!(read.bytes(), b"original contents");
}

#[test]
fn child_names_cannot_escape_or_select_streams_devices_or_aliases() {
    let (_temp, root, parent) = private_root();
    for name in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "NUL",
        "stream:ads",
        "alias.",
        "space ",
    ] {
        assert!(parent.create_child(Path::new(name)).is_err());
        assert!(parent.open_child(Path::new(name)).is_err());
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    assert!(parent.open_child(Path::new("absent")).is_err());
    assert!(!root.join("absent").exists());
}

#[test]
fn inherited_existing_child_is_refused_without_repairing_its_identity_or_content() {
    let (_temp, root, parent) = private_root();
    let inherited = root.join("inherited");
    fs::create_dir(&inherited).unwrap();
    fs::write(inherited.join("marker.bin"), b"existing inherited state").unwrap();
    let file = handles::directory(&inherited).unwrap();
    let identity = handles::identity(&file, true).unwrap();
    assert!(security::verify(&file, &security::owner_sid().unwrap(), true).is_err());
    assert!(parent.open_child(Path::new("inherited")).is_err());
    assert!(parent.create_child(Path::new("inherited")).is_err());
    assert_eq!(handles::identity(&file, true).unwrap(), identity);
    assert_eq!(
        fs::read(inherited.join("marker.bin")).unwrap(),
        b"existing inherited state"
    );
    assert!(security::verify(&file, &security::owner_sid().unwrap(), true).is_err());
}

#[test]
fn child_depth_limit_refuses_before_creating_an_extra_directory() {
    let (_temp, _root, mut directory) = private_root();
    while directory.parents.len() < 128 {
        directory = directory.create_child(Path::new("next")).unwrap();
    }
    let absent = directory.paths.last().unwrap().join("too-deep");
    assert!(directory.create_child(Path::new("too-deep")).is_err());
    assert!(directory.open_child(Path::new("too-deep")).is_err());
    assert!(!absent.exists());
    directory.validate_original().unwrap();
}
