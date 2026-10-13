//! Real Windows provisioning fixtures; no execution has occurred in this capsule.
use super::*;
use std::{
    fs,
    process::{Command, Stdio},
};

fn parent_path(path: &Path) -> PathBuf {
    let file = handles::directory(path).unwrap();
    let physical = handles::final_path(&file).unwrap();
    PathBuf::from(physical.strip_prefix(r"\\?\").unwrap())
}

fn acl_change(path: &Path, arguments: &[&str]) {
    let status = Command::new("icacls.exe")
        .arg(path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(
        status.success(),
        "real private fixture descriptor change failed"
    );
}

#[test]
fn missing_nested_directories_are_private_and_reopen_without_changing_acl_or_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = parent_path(temp.path())
        .join("missing-parent")
        .join("private-root");
    let held = PrivateDirectory::create_directories(&root).unwrap();
    held.validate().unwrap();
    let owner = security::owner_sid().unwrap();
    security::verify(
        &handles::directory(root.parent().unwrap()).unwrap(),
        &owner,
        true,
    )
    .unwrap();
    let before = handles::identity(held.root_handle().unwrap(), true).unwrap();
    assert!(fs::rename(&root, root.with_file_name("moved")).is_err());
    let reopened = PrivateDirectory::create_directories(&root).unwrap();
    assert_eq!(
        handles::identity(reopened.root_handle().unwrap(), true).unwrap(),
        before
    );
    drop(reopened);
    drop(held);
    let moved = root.with_file_name("moved");
    fs::rename(&root, &moved).unwrap();
    PrivateDirectory::open(&moved).unwrap();
}

#[test]
fn existing_broad_final_directory_is_refused_without_repair_or_byte_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = parent_path(temp.path()).join("private-root");
    let held = PrivateDirectory::create_directories(&root).unwrap();
    write_new(&held, Path::new("unchanged.bin"), b"complete existing").unwrap();
    drop(held);
    acl_change(&root, &["/grant", "*S-1-1-0:(RX)"]);
    assert!(PrivateDirectory::create_directories(&root).is_err());
    let owner = security::owner_sid().unwrap();
    assert!(security::verify(&handles::directory(&root).unwrap(), &owner, true).is_err());
    assert_eq!(
        fs::read(root.join("unchanged.bin")).unwrap(),
        b"complete existing"
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn actual_root_owner_descriptor_change_is_refused_by_held_and_fresh_checks() {
    let temp = tempfile::tempdir().unwrap();
    let root = parent_path(temp.path()).join("private-root");
    let held = PrivateDirectory::create_directories(&root).unwrap();
    acl_change(&root, &["/setowner", "*S-1-5-32-544"]);
    assert!(held.validate().is_err());
    assert!(PrivateDirectory::open(&root).is_err());
    assert!(atomic_write(&held, Path::new("absent.bin"), b"private new").is_err());
    assert!(!root.join("absent.bin").exists());
}

#[test]
fn aliases_refuse_before_creating_any_missing_directory() {
    let temp = tempfile::tempdir().unwrap();
    let parent = parent_path(temp.path());
    for root in [
        parent.join(".."),
        parent.join("NUL"),
        parent.join("trailing."),
        parent.join("alias:stream"),
    ] {
        assert!(PrivateDirectory::create_directories(&root).is_err());
    }
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
}
