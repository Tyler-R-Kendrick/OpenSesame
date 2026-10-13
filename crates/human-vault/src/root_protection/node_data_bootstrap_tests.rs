//! Genuine private filesystem and kernel-lease provisioning controls, not realm/crypto proof.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::{write_new, HeldPrivateRead};
#[cfg(windows)]
use crate::root_protection::windows_private_files::{write_new, HeldPrivateRead};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("node-state");
    #[cfg(windows)]
    let path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("node-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([51; 32])).as_bytes(),
    )
    .unwrap();
    (temp, root)
}
#[test]
fn actual_missing_roots_are_created_under_nested_leases_and_existing_bytes_are_preserved() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.capture_existing_writer("first").is_err());
    let before = credential.capture_device_inventory().unwrap();
    assert!(before.tombs().unwrap().is_empty());
    let writer = credential.bootstrap_writer("first").unwrap();
    assert!(before.validate().is_err());
    // This genuine retained catalogue keeps its credential Arc/OS lease until explicitly drained.
    drop(before);
    assert!(credential.bootstrap_writer("first").is_err());
    assert!(state.credential_writer().is_err());
    writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            Path::new("record"),
            None,
            Some(b"original physical fixture"),
        )
        .unwrap();
    let identity = writer
        .resource_identity(NativeNodeDataScope::Vault)
        .unwrap();
    drop(writer);
    let writer = credential.bootstrap_writer("first").unwrap();
    assert_eq!(
        writer
            .resource_identity(NativeNodeDataScope::Vault)
            .unwrap(),
        identity
    );
    assert_eq!(
        writer
            .read(NativeNodeDataScope::Vault, Path::new("record"), 64)
            .unwrap(),
        b"original physical fixture"
    );
    drop(credential);
    assert!(state.credential_writer().is_err());
    drop(writer);
    state.credential_writer().unwrap();
}
#[test]
fn body_contention_and_invalid_names_cannot_create_missing_scoped_roots() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let held = state
        .exclusive_lease("opensesame:vault-body:first")
        .unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.bootstrap_writer("first").is_err());
    for tomb in ["", "../first", ".first", "first/", "é"] {
        assert!(credential.bootstrap_writer(tomb).is_err());
    }
    assert!(root.open_child(Path::new("vault")).is_err());
    assert!(root.open_child(Path::new("origin-files")).is_err());
    drop(held);
    credential.bootstrap_writer("first").unwrap();
}
#[test]
fn unsafe_existing_fixed_root_is_refused_without_creating_the_other_root() {
    let (_temp, root) = fixture();
    write_new(&root, Path::new("origin-files"), b"not a directory").unwrap();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.bootstrap_writer("first").is_err());
    assert!(root.open_child(Path::new("vault")).is_err());
    let mut held = HeldPrivateRead::open(root, Path::new("origin-files"), 64).unwrap();
    held.validate().unwrap();
    assert_eq!(held.bytes(), b"not a directory");
}
#[test]
fn sealed_original_state_refuses_provisioning_before_creation() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    state.seal().unwrap();
    assert!(credential.bootstrap_writer("first").is_err());
    assert!(root.open_child(Path::new("vault")).is_err());
}
#[cfg(any(windows, target_os = "macos", target_os = "ios"))]
#[test]
fn actual_catalogue_spelling_is_required_before_a_different_body_digest() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    drop(credential.bootstrap_writer("Original").unwrap());
    assert!(credential.bootstrap_writer("original").is_err());
    credential.bootstrap_writer("Original").unwrap();
}

#[cfg(unix)]
#[test]
fn actual_original_key_change_refuses_before_any_bootstrap_directory_effect() {
    let (temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    fs::write(
        temp.path().join("node-state/at-rest.key"),
        format!("{}\n", STANDARD.encode([52; 32])),
    )
    .unwrap();
    assert!(credential.bootstrap_writer("first").is_err());
    assert!(root.open_child(Path::new("vault")).is_err());
    assert!(root.open_child(Path::new("origin-files")).is_err());
}
#[test]
fn genuine_catalogue_budget_refuses_the_129th_tomb_without_creating_it() {
    let (_temp, root) = fixture();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    for index in 0..128 {
        vaults
            .create_child(Path::new(&format!("t{index:03}")))
            .unwrap();
    }
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.bootstrap_writer("new").is_err());
    assert!(vaults.open_child(Path::new("new")).is_err());
    credential.bootstrap_writer("t000").unwrap();
}
