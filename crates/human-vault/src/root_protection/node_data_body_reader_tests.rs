use super::*;

#[test]
fn actual_body_only_reader_authenticates_fixed_generation_and_device_without_credential() {
    let (_temporary, root) = fixture();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    let vault = vaults.create_child(Path::new("selected")).unwrap();
    let origin = root.create_child(Path::new("origin-files")).unwrap();
    let context = binding("selected", &identity(&vault).unwrap()).unwrap();
    let generation = sealed_generation(&context, b"actual fixed generation inner data");
    write_new(&vault, Path::new(GENERATION), &generation).unwrap();
    let logical = "tomb/selected/retired-credentials.v2";
    let leaf = modern_name(logical).unwrap();
    let device = sealed(
        "node-device-record-v1",
        &binding(logical, &leaf).unwrap(),
        b"actual fixed device data",
    );
    write_new(&origin, Path::new(&leaf), &device).unwrap();
    let state = NativeNodeDataState::capture(root).unwrap();
    let body = state
        .try_shared_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap();
    let reader = state.capture_body_reader("selected", body).unwrap();
    assert_eq!(
        reader.read_optional_generation_ciphertext().unwrap(),
        Some(generation)
    );
    assert_eq!(
        reader
            .read_optional_modern_device_ciphertext(logical)
            .unwrap(),
        Some(device)
    );
    assert!(reader
        .read_optional_modern_device_ciphertext("tomb/foreign/retired-credentials.v2")
        .is_err());
    reader.validate().unwrap();
    let credential = state.try_credential_writer().unwrap().unwrap();
    assert!(credential
        .try_capture_existing_writer("selected")
        .unwrap()
        .is_none());
    drop(credential);
    drop(reader);
    state
        .try_exclusive_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap();
}
#[test]
fn actual_body_reader_refuses_wrong_name_foreign_original_and_sealed_state() {
    let (_temporary, root) = fixture();
    let vaults = root.create_child(Path::new("vault")).unwrap();
    let vault = vaults.create_child(Path::new("selected")).unwrap();
    root.create_child(Path::new("origin-files")).unwrap();
    let state = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    let wrong = state
        .try_shared_lease("wrong-original-body-name")
        .unwrap()
        .unwrap();
    assert!(state.capture_body_reader("selected", wrong).is_err());
    let other = NativeNodeDataState::capture(root).unwrap();
    let foreign = other
        .try_shared_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap();
    assert!(state.capture_body_reader("selected", foreign).is_err());
    let body = state
        .try_shared_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap();
    assert!(state.capture_body_reader("SELECTED", body).is_err());
    let body = state
        .try_shared_lease("opensesame:vault-body:selected")
        .unwrap()
        .unwrap();
    let reader = state.capture_body_reader("selected", body).unwrap();
    assert!(reader
        .read_optional_generation_ciphertext()
        .unwrap()
        .is_none());
    write_new(
        &vault,
        Path::new(GENERATION),
        b"plaintext must never escape",
    )
    .unwrap();
    assert!(reader.read_optional_generation_ciphertext().is_err());
    state.seal().unwrap();
    assert!(reader.validate().is_err());
    assert!(reader.read_optional_generation_ciphertext().is_err());
    assert!(reader.inventory(NativeNodeDataScope::Vault, 4096).is_err());
    assert!(reader
        .resource_identity(NativeNodeDataScope::Vault)
        .is_err());
}
