//! Actual NTFS actor/retained-handle controls, authored only; physical bytes are not vault AEAD proof.
use super::super::write_new;
use super::*;
use crate::root_protection::node_data_state::{NativeNodeDataScope, NativeNodeDataState};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    let path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("node-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([23; 32])).as_bytes(),
    )
    .unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    root.create_child(Path::new("vault"))
        .unwrap()
        .create_child(Path::new("selected"))
        .unwrap();
    (temp, root)
}
#[test]
fn genuine_ntfs_write_through_create_replace_detach_delete_and_reopen_ack() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.capture_existing_writer("SELECTED").is_err());
    let writer = credential.capture_existing_writer("selected").unwrap();
    let scope = NativeNodeDataScope::Vault;
    let leaf = Path::new("opaque.bin");
    writer
        .compare_publish(scope, leaf, None, Some(b"first physical ciphertext"))
        .unwrap();
    assert_eq!(
        writer.read(scope, leaf, 64).unwrap(),
        b"first physical ciphertext"
    );
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"wrong absent expectation"))
        .is_err());
    assert!(writer
        .compare_publish(
            scope,
            leaf,
            Some(b"wrong bytes"),
            Some(b"wrong replacement")
        )
        .is_err());
    writer
        .compare_publish(
            scope,
            leaf,
            Some(b"first physical ciphertext"),
            Some(b"second physical ciphertext"),
        )
        .unwrap();
    assert_eq!(
        writer.read(scope, leaf, 64).unwrap(),
        b"second physical ciphertext"
    );
    assert_eq!(
        writer.inventory(scope, 1).unwrap(),
        vec![("opaque.bin".into(), false)]
    );
    writer
        .compare_publish(
            NativeNodeDataScope::Origin,
            leaf,
            None,
            Some(b"origin physical ciphertext"),
        )
        .unwrap();
    drop(writer);
    drop(credential);
    drop(state);
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    assert_eq!(
        writer.read(scope, leaf, 64).unwrap(),
        b"second physical ciphertext"
    );
    writer
        .compare_publish(scope, leaf, Some(b"second physical ciphertext"), None)
        .unwrap();
    assert!(writer.inventory(scope, 1).unwrap().is_empty());
    let stages = root
        .open_child(Path::new("vault-native-stages-v1"))
        .unwrap();
    assert!(stages
        .original_bounded_directory_entries(64)
        .unwrap()
        .is_empty());
    writer.compare_publish(scope, leaf, None, None).unwrap();
    state.seal().unwrap();
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"sealed replacement"))
        .is_err());
}
#[test]
fn genuine_unknown_and_full_orphan_stage_inventory_refuses_without_deleting_evidence() {
    let (temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    let stages = root
        .create_child(Path::new("vault-native-stages-v1"))
        .unwrap();
    write_new(&stages, Path::new("unknown.bin"), b"unknown physical bytes").unwrap();
    let leaf = Path::new("opaque.bin");
    assert!(writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            leaf,
            None,
            Some(b"refuse unknown stage")
        )
        .is_err());
    let parent = fs::canonicalize(temp.path()).unwrap();
    let root_path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("node-state");
    assert!(!root_path.join("vault/selected/opaque.bin").exists());
    fs::remove_file(root_path.join("vault-native-stages-v1/unknown.bin")).unwrap();
    for _ in 0..64 {
        let name = format!(".opensesame-data-stage-{}", uuid::Uuid::new_v4());
        write_new(&stages, Path::new(&name), b"orphan physical ciphertext").unwrap();
    }
    assert!(writer
        .compare_publish(
            NativeNodeDataScope::Vault,
            leaf,
            None,
            Some(b"refuse budget")
        )
        .is_err());
    assert_eq!(
        stages.original_bounded_directory_entries(64).unwrap().len(),
        64
    );
    assert!(!root_path.join("vault/selected/opaque.bin").exists());
}
