//! Genuine retained namespace/lease controls; literal files are filesystem DATA, not codec/owner proofs.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use crate::root_protection::windows_private_files::write_new;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, path::PathBuf};
fn fixture() -> (tempfile::TempDir, PathBuf, Arc<PrivateDirectory>) {
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
        format!("{}\n", STANDARD.encode([31; 32])).as_bytes(),
    )
    .unwrap();
    (temp, path, root)
}
#[test]
fn actual_credential_only_catalogue_origin_and_two_vaults_retain_exact_data_without_reacquisition()
{
    let (_temp, _path, root) = fixture();
    let origin = root.create_child(Path::new("origin-files")).unwrap();
    write_new(
        &origin,
        Path::new("device-slot.bin"),
        b"origin physical ciphertext",
    )
    .unwrap();
    let catalogue = root.create_child(Path::new("vault")).unwrap();
    for tomb in ["first", "second"] {
        let vault = catalogue.create_child(Path::new(tomb)).unwrap();
        write_new(
            &vault,
            Path::new("observed-slot.bin"),
            b"vault physical ciphertext",
        )
        .unwrap();
    }
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let inventory = credential.capture_device_inventory().unwrap();
    drop(credential);
    assert!(state.credential_writer().is_err());
    assert_eq!(inventory.tombs().unwrap(), vec!["first", "second"]);
    assert_eq!(
        inventory.origin_names().unwrap(),
        vec![("device-slot.bin".into(), false)]
    );
    assert_eq!(
        inventory.vault_names("second").unwrap(),
        vec![("observed-slot.bin".into(), false)]
    );
    assert_eq!(
        inventory
            .read_origin(Path::new("device-slot.bin"), 64)
            .unwrap(),
        b"origin physical ciphertext"
    );
    assert_eq!(
        inventory
            .read_vault("second", Path::new("observed-slot.bin"), 64)
            .unwrap(),
        b"vault physical ciphertext"
    );
    assert!(inventory
        .read_origin(Path::new("../at-rest.key"), 64)
        .is_err());
    assert!(inventory
        .read_vault("SECOND", Path::new("observed-slot.bin"), 64)
        .is_err());
    assert!(inventory.vault_identity("uncatalogued").is_err());
    assert!(inventory.origin_identity().unwrap().is_some());
    assert_ne!(
        inventory.vault_identity("first").unwrap(),
        inventory.vault_identity("second").unwrap()
    );
    inventory.validate().unwrap();
    state.seal().unwrap();
    assert!(inventory.validate().is_err());
    assert!(inventory.tombs().is_err());
    assert!(inventory.origin_names().is_err());
    assert!(inventory
        .read_origin(Path::new("device-slot.bin"), 64)
        .is_err());
}
#[test]
fn genuine_absent_roots_are_explicit_and_later_creation_invalidates_original_inventory() {
    let (_temp, _path, root) = fixture();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let credential = state.credential_writer().unwrap();
    let inventory = credential.capture_device_inventory().unwrap();
    assert!(inventory.tombs().unwrap().is_empty());
    assert!(inventory.origin_names().unwrap().is_empty());
    assert!(inventory.origin_identity().unwrap().is_none());
    assert_eq!(
        inventory
            .read_origin(Path::new("missing.bin"), 64)
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    root.create_child(Path::new("origin-files")).unwrap();
    assert!(inventory.validate().is_err());
    assert!(inventory.read_origin(Path::new("missing.bin"), 64).is_err());
    drop(inventory);
    credential
        .capture_device_inventory()
        .unwrap()
        .validate()
        .unwrap();
}
#[test]
fn actual_catalogue_and_name_budgets_refuse_before_unbounded_retained_roots_or_file_work() {
    let (_temp, path, root) = fixture();
    let catalogue = root.create_child(Path::new("vault")).unwrap();
    for index in 0..129 {
        catalogue
            .create_child(Path::new(&format!("tomb-{index}")))
            .unwrap();
    }
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    assert!(credential.capture_device_inventory().is_err());
    assert_eq!(fs::read_dir(path.join("vault")).unwrap().count(), 129);
    let (_other_temp, other_path, other_root) = fixture();
    other_root.create_child(Path::new("origin-files")).unwrap();
    for index in 0..4097 {
        let file = other_path
            .join("origin-files")
            .join(format!("slot-{index}.bin"));
        fs::write(&file, b"physical budget fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    let other_state = NativeNodeDataState::capture(other_root).unwrap();
    let other_credential = other_state.credential_writer().unwrap();
    assert!(other_credential.capture_device_inventory().is_err());
    assert_eq!(
        fs::read_dir(other_path.join("origin-files"))
            .unwrap()
            .count(),
        4097
    );
}

#[test]
fn actual_optional_parent_case_alias_is_never_misreported_as_an_absent_catalogue() {
    for name in ["origin-files", "vault"] {
        let (_temp, path, root) = fixture();
        let alias = name.to_ascii_uppercase();
        drop(root.create_child(Path::new(&alias)).unwrap());
        let actual_absent = match fs::symlink_metadata(path.join(name)) {
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => panic!("independent fixture lookup failed: {error}"),
        };
        assert_eq!(
            root.original_entry_absent(Path::new(name)).unwrap(),
            actual_absent
        );
        let state = NativeNodeDataState::capture(root).unwrap();
        let credential = state.credential_writer().unwrap();
        let captured = credential.capture_device_inventory();
        if actual_absent {
            let inventory = captured.unwrap();
            assert!(inventory.tombs().unwrap().is_empty());
            assert!(inventory.origin_names().unwrap().is_empty());
        } else {
            assert!(captured.is_err());
        }
    }
}
#[test]
fn actual_later_case_alias_creation_retires_original_absent_parent_observation() {
    for name in ["origin-files", "vault"] {
        let (_temp, path, root) = fixture();
        let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
        let credential = state.credential_writer().unwrap();
        let inventory = credential.capture_device_inventory().unwrap();
        drop(
            root.create_child(Path::new(&name.to_ascii_uppercase()))
                .unwrap(),
        );
        match fs::symlink_metadata(path.join(name)) {
            Ok(_) => assert!(inventory.validate().is_err()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => inventory.validate().unwrap(),
            Err(error) => panic!("independent fixture lookup failed: {error}"),
        }
    }
}
