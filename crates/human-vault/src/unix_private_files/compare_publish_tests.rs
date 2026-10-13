//! Actual native actor/OS filesystem controls; opaque bytes are not authenticated vault fixtures.
use super::*;
use crate::root_protection::node_data_state::{NativeNodeDataScope, NativeNodeDataState};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, os::unix::fs::PermissionsExt};
fn fixture() -> (tempfile::TempDir, Arc<PrivateDirectory>) {
    let temp = tempfile::tempdir().unwrap();
    let path = fs::canonicalize(temp.path()).unwrap().join("node-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(
        &root,
        Path::new("at-rest.key"),
        format!("{}\n", STANDARD.encode([17; 32])).as_bytes(),
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
fn actual_ordered_actor_create_compare_replace_delete_ack_and_noop_absence() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
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
    assert_eq!(
        writer.read(scope, leaf, 64).unwrap(),
        b"first physical ciphertext"
    );
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
    let stages = root
        .open_child(Path::new("vault-native-stages-v1"))
        .unwrap();
    assert!(stages
        .original_bounded_directory_entries(64)
        .unwrap()
        .is_empty());
    writer
        .compare_publish(scope, leaf, Some(b"second physical ciphertext"), None)
        .unwrap();
    assert!(writer.inventory(scope, 1).unwrap().is_empty());
    writer.compare_publish(scope, leaf, None, None).unwrap();
    writer
        .compare_publish(
            NativeNodeDataScope::Origin,
            leaf,
            None,
            Some(b"origin physical ciphertext"),
        )
        .unwrap();
    assert_eq!(
        writer.read(NativeNodeDataScope::Origin, leaf, 64).unwrap(),
        b"origin physical ciphertext"
    );
    state.seal().unwrap();
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"sealed replacement"))
        .is_err());
}
#[test]
fn actual_unsafe_aliases_and_unbounded_or_unknown_orphan_stages_refuse_without_repair() {
    let (temp, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    let scope = NativeNodeDataScope::Vault;
    let leaf = Path::new("opaque.bin");
    let root_path = fs::canonicalize(temp.path()).unwrap().join("node-state");
    std::os::unix::fs::symlink("unrelated", root_path.join("vault/selected/opaque.bin")).unwrap();
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"no alias replacement"))
        .is_err());
    fs::remove_file(root_path.join("vault/selected/opaque.bin")).unwrap();
    let stages = root
        .create_child(Path::new("vault-native-stages-v1"))
        .unwrap();
    write_new(&stages, Path::new("unknown.bin"), b"unknown physical bytes").unwrap();
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"unknown stage refusal"))
        .is_err());
    assert!(!root_path.join("vault/selected/opaque.bin").exists());
    fs::remove_file(root_path.join("vault-native-stages-v1/unknown.bin")).unwrap();
    for _ in 0..64 {
        let name = format!(".opensesame-data-stage-{}", uuid::Uuid::new_v4());
        write_new(&stages, Path::new(&name), b"orphan physical ciphertext").unwrap();
    }
    assert!(writer
        .compare_publish(scope, leaf, None, Some(b"budget refusal"))
        .is_err());
    assert_eq!(
        stages.original_bounded_directory_entries(64).unwrap().len(),
        64
    );
    assert!(!root_path.join("vault/selected/opaque.bin").exists());
    fs::set_permissions(root_path.join("vault"), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(writer.compare_publish(scope, leaf, None, None).is_err());
}
