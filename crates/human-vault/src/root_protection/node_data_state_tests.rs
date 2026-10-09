//! Genuine original filesystem/OS lease controls; physical fixture bytes are not vault AEAD proof.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use crate::root_protection::windows_private_files::write_new;
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
        format!("{}\n", STANDARD.encode([41; 32])).as_bytes(),
    )
    .unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    let vault = vaults.create_child(Path::new("selected")).unwrap();
    write_new(
        &vault,
        Path::new("opaque.json"),
        b"physical ciphertext fixture",
    )
    .unwrap();
    (temp, root)
}

#[test]
fn genuine_nested_leases_retain_original_data_without_reacquisition_and_drop_release() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(state.credential_writer().is_err());
    let writer = credential.capture_existing_writer("selected").unwrap();
    assert!(credential.capture_existing_writer("selected").is_err());
    state.validate().unwrap();
    credential.validate().unwrap();
    writer.validate().unwrap();
    drop(credential);
    assert!(state.credential_writer().is_err());
    let scope = NativeNodeDataScope::Vault;
    assert_eq!(
        writer.read(scope, Path::new("opaque.json"), 64).unwrap(),
        b"physical ciphertext fixture"
    );
    assert_eq!(
        writer.inventory(scope, 1).unwrap(),
        vec![("opaque.json".into(), false)]
    );
    assert_eq!(
        writer.resource_identity(scope).unwrap(),
        writer.resource_identity(scope).unwrap()
    );
    assert!(writer.read(scope, Path::new("../at-rest.key"), 64).is_err());
    assert!(writer.read(scope, Path::new("opaque.json"), 4).is_err());
    assert!(writer.read(scope, Path::new("missing.json"), 64).is_err());
    drop(writer);
    let credential = state.credential_writer().unwrap();
    credential.capture_existing_writer("selected").unwrap();
}

#[test]
fn actual_shared_wrong_name_and_foreign_original_leases_never_pass_private_writer_validation() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let shared =
        HeldPrivateWriterLease::shared(Arc::clone(&state.locks), NODE_CREDENTIAL_LEASE).unwrap();
    assert!(shared
        .validate_exclusive_for(&state.locks, NODE_CREDENTIAL_LEASE)
        .is_err());
    assert!(state.credential_writer().is_err());
    drop(shared);
    let credential = state.credential_writer().unwrap();
    assert!(credential
        .credential
        .validate_exclusive_for(&state.locks, "opensesame:vault-body:selected")
        .is_err());
    let alternate = Arc::new(
        state
            .root
            .open_child(Path::new(NODE_LOCK_DIRECTORY))
            .unwrap(),
    );
    assert!(credential
        .credential
        .validate_exclusive_for(&alternate, NODE_CREDENTIAL_LEASE)
        .is_err());
    let (_foreign_temp, foreign_root) = fixture();
    let foreign = NativeNodeDataState::capture(foreign_root).unwrap();
    assert!(credential
        .credential
        .validate_exclusive_for(&foreign.locks, NODE_CREDENTIAL_LEASE)
        .is_err());
    for tomb in [
        "",
        "../selected",
        "/selected",
        ".selected",
        "selected/",
        "é",
    ] {
        assert!(credential.capture_existing_writer(tomb).is_err());
    }
    assert!(credential
        .capture_existing_writer(&"x".repeat(201))
        .is_err());
}

#[test]
fn explicit_state_seal_drains_and_refuses_every_retained_data_descendant() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    state.seal().unwrap();
    assert!(state.validate().is_err());
    assert!(credential.validate().is_err());
    assert!(writer.validate().is_err());
    assert!(state.credential_writer().is_err());
    assert!(state.shared_lease("ordinary-host-lock").is_err());
    assert!(state.exclusive_lease("ordinary-host-lock").is_err());
    assert!(credential.capture_existing_writer("selected").is_err());
    assert!(writer
        .read(NativeNodeDataScope::Vault, Path::new("opaque.json"), 64)
        .is_err());
    assert!(writer.inventory(NativeNodeDataScope::Origin, 128).is_err());
    assert!(writer
        .resource_identity(NativeNodeDataScope::Vault)
        .is_err());
    state.seal().unwrap();
}

#[test]
fn genuine_generic_host_shared_and_exclusive_modes_preserve_actual_kernel_contention() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let first = state.shared_lease("ordinary-host-lock").unwrap();
    let second = state.shared_lease("ordinary-host-lock").unwrap();
    assert!(state.exclusive_lease("ordinary-host-lock").is_err());
    first.validate().unwrap();
    second.validate().unwrap();
    drop(first);
    drop(second);
    let held = state.exclusive_lease("ordinary-host-lock").unwrap();
    assert!(state.shared_lease("ordinary-host-lock").is_err());
    drop(held);
    state.shared_lease("ordinary-host-lock").unwrap();
}

#[cfg(unix)]
#[test]
fn actual_original_key_rewrite_and_parent_mode_change_refuse_retained_actors() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, root) = fixture();
    let parent = fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("node-state");
    #[cfg(windows)]
    let path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("node-state");
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.capture_existing_writer("selected").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(writer.inventory(NativeNodeDataScope::Vault, 128).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        path.join("at-rest.key"),
        format!("{}\n", STANDARD.encode([42; 32])),
    )
    .unwrap();
    assert!(writer
        .read(NativeNodeDataScope::Vault, Path::new("opaque.json"), 64)
        .is_err());
    assert!(credential.capture_existing_writer("selected").is_err());
    assert!(state.credential_writer().is_err());
}
