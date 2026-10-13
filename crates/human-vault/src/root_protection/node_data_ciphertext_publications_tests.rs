//! Real original OS leases/files and genuine encrypted fixture controls; no owner stand-in.
use super::*;
#[test]
fn authenticated_generation_create_replace_conflict_delete_and_seal_use_original_io() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    let context = binding("selected", &identity(&writer.vault).unwrap()).unwrap();
    let first = sealed_generation(&context, b"first genuine encrypted payload");
    let second = sealed_generation(&context, b"second genuine encrypted payload");
    assert!(writer
        .compare_publish_generation_ciphertext(None, None)
        .is_err());
    assert!(writer
        .compare_publish_generation_ciphertext(None, Some(b"plaintext"))
        .is_err());
    assert!(writer
        .read_optional_generation_ciphertext()
        .unwrap()
        .is_none());
    writer
        .compare_publish_generation_ciphertext(None, Some(&first))
        .unwrap();
    assert_eq!(writer.read_generation_ciphertext().unwrap(), first);
    assert!(writer
        .compare_publish_generation_ciphertext(None, Some(&second))
        .is_err());
    assert!(writer
        .compare_publish_generation_ciphertext(Some(&second), Some(&first))
        .is_err());
    let legacy = sealed("node-vault-generation-v1", &context, b"forbidden legacy");
    assert!(writer
        .compare_publish_generation_ciphertext(Some(&first), Some(&legacy))
        .is_err());
    let foreign = sealed_generation(
        &binding("foreign", &identity(&writer.vault).unwrap()).unwrap(),
        b"foreign",
    );
    assert!(writer
        .compare_publish_generation_ciphertext(Some(&first), Some(&foreign))
        .is_err());
    assert_eq!(writer.read_generation_ciphertext().unwrap(), first);
    writer
        .compare_publish_generation_ciphertext(Some(&first), Some(&second))
        .unwrap();
    assert_eq!(writer.read_generation_ciphertext().unwrap(), second);
    writer
        .compare_publish_generation_ciphertext(Some(&second), None)
        .unwrap();
    assert!(writer
        .read_optional_generation_ciphertext()
        .unwrap()
        .is_none());
    state.seal().unwrap();
    assert!(writer
        .compare_publish_generation_ciphertext(None, Some(&first))
        .is_err());
}
#[test]
fn authenticated_device_scope_and_expected_bytes_cannot_be_substituted() {
    let (_temp, root) = fixture();
    let state = NativeNodeDataState::capture(root).unwrap();
    let credential = state.credential_writer().unwrap();
    let writer = credential.bootstrap_writer("selected").unwrap();
    let logical = "tomb/selected/retired-credentials.v2";
    let leaf = modern_name(logical).unwrap();
    let context = binding(logical, &leaf).unwrap();
    let first = sealed(
        "node-device-record-v1",
        &context,
        b"first genuine device payload",
    );
    let second = sealed(
        "node-device-record-v1",
        &context,
        b"second genuine device payload",
    );
    for invalid in [
        "tomb/foreign/retired-credentials.v2",
        "unknown-global-key",
        "tomb/selected/../x",
    ] {
        assert!(writer
            .compare_publish_modern_device_ciphertext(invalid, None, Some(&first))
            .is_err());
    }
    assert!(writer
        .compare_publish_modern_device_ciphertext(logical, None, Some(b"osr2.plaintext-shaped"))
        .is_err());
    assert!(writer
        .read_optional_modern_device_ciphertext(logical)
        .unwrap()
        .is_none());
    writer
        .compare_publish_modern_device_ciphertext(logical, None, Some(&first))
        .unwrap();
    assert_eq!(
        writer.read_modern_device_ciphertext(logical).unwrap(),
        first
    );
    assert!(writer
        .compare_publish_modern_device_ciphertext(logical, Some(b"plaintext expected"), None)
        .is_err());
    assert!(writer
        .compare_publish_modern_device_ciphertext(logical, Some(&second), None)
        .is_err());
    writer
        .compare_publish_modern_device_ciphertext(logical, Some(&first), Some(&second))
        .unwrap();
    assert_eq!(
        writer.read_modern_device_ciphertext(logical).unwrap(),
        second
    );
    writer
        .compare_publish_modern_device_ciphertext(logical, Some(&second), None)
        .unwrap();
    assert!(writer
        .read_optional_modern_device_ciphertext(logical)
        .unwrap()
        .is_none());
    let global_leaf = modern_name(GLOBAL_KEY).unwrap();
    let global = sealed(
        "node-device-record-v1",
        &binding(GLOBAL_KEY, &global_leaf).unwrap(),
        b"global enrollment fixture",
    );
    writer
        .compare_publish_modern_device_ciphertext(GLOBAL_KEY, None, Some(&global))
        .unwrap();
    assert_eq!(
        writer.read_modern_device_ciphertext(GLOBAL_KEY).unwrap(),
        global
    );
}
