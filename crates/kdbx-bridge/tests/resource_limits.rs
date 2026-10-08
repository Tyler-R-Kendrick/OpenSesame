//! Public import paths use the same bounded policy as the header screen.

mod common;

use keepass::{config::KdfConfig, DatabaseKey};
use opensesame_kdbx_bridge::{
    export_kdbx, import_kdbx, map_kdbx, ExportOptions, ImportOptions, KdbxError,
};

use common::{
    build_conformance_db_with, build_weak_bytes, fixture_bytes, put, store_state, temp_store,
    weak_config, FIXTURE_PASSWORD,
};

const INVALID_FLAGS: &[u8] = include_bytes!("fixtures/legacy-invalid-flags.kdb");

fn refuses_without_writes(bytes: &[u8], expected: &str) {
    let target = temp_store();
    put(&target, "existing", "generated-original-secret", "");
    let original = store_state(&target.root, &target.key);
    let err = import_kdbx(
        bytes,
        Some(FIXTURE_PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default().replacing(),
    )
    .expect_err("resource policy must refuse before importing");
    assert!(matches!(&err, KdbxError::Malformed(_)), "{err}");
    assert!(err.to_string().contains(expected), "{err}");
    assert!(!err.to_string().contains(FIXTURE_PASSWORD));
    assert_eq!(store_state(&target.root, &target.key), original);
}

#[test]
fn captured_legacy_timeout_refuses_before_import_or_supported_cipher_work() {
    assert_eq!(INVALID_FLAGS.len(), 204);
    refuses_without_writes(INVALID_FLAGS, "unsupported KDB cipher flags");
    // Supported outer ciphers still use the captured high-work AES KDF.
    for flags in [2u32, 8, 10] {
        let mut supported = INVALID_FLAGS.to_vec();
        supported[8..12].copy_from_slice(&flags.to_le_bytes());
        refuses_without_writes(&supported, "AES-KDF round count");
    }
}

#[test]
fn complete_native_aes_database_maps_and_imports_with_original_credentials() {
    let mut config = weak_config();
    config.kdf_config = KdfConfig::Aes { rounds: 60_000 };
    let database = build_conformance_db_with(config);
    let mut bytes = Vec::new();
    database
        .save(
            &mut bytes,
            DatabaseKey::new().with_password(FIXTURE_PASSWORD),
        )
        .expect("write genuine AES fixture");
    let (items, _) = map_kdbx(&bytes, Some(FIXTURE_PASSWORD), None, None).unwrap();
    assert_eq!(items.len(), 5);
    assert!(matches!(
        map_kdbx(&bytes, Some("different-generated-password"), None, None),
        Err(KdbxError::Locked)
    ));
    let target = temp_store();
    let imported = import_kdbx(
        &bytes,
        Some(FIXTURE_PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .unwrap();
    assert_eq!(imported.created.len(), 5);
    assert_eq!(store_state(&target.root, &target.key).len(), 5);
}

#[test]
fn real_default_export_remains_importable_under_resource_policy() {
    let source = temp_store();
    put(&source, "default-entry", "generated-export-secret", "");
    let bytes = export_kdbx(
        &source.root,
        &source.key,
        None,
        FIXTURE_PASSWORD,
        ExportOptions::default(),
    )
    .unwrap();
    let target = temp_store();
    import_kdbx(
        &bytes,
        Some(FIXTURE_PASSWORD),
        None,
        &target.root,
        &target.key,
        ImportOptions::default(),
    )
    .unwrap();
    assert_eq!(
        store_state(&target.root, &target.key),
        store_state(&source.root, &source.key)
    );
}

#[test]
fn committed_conformance_database_remains_importable() {
    let (items, _) = map_kdbx(&fixture_bytes(), Some(FIXTURE_PASSWORD), None, None).unwrap();
    assert_eq!(items.len(), 5);
}

fn read_len(bytes: &[u8]) -> usize {
    usize::try_from(u32::from_le_bytes(bytes.try_into().unwrap())).unwrap()
}

fn kdf_dictionary(bytes: &mut [u8]) -> &mut [u8] {
    let mut pos = 12;
    loop {
        let id = bytes[pos];
        let size = read_len(&bytes[pos + 1..pos + 5]);
        let start = pos + 5;
        if id == 11 {
            return &mut bytes[start..start + size];
        }
        assert_ne!(id, 0, "genuine writer must provide KDF parameters");
        pos = start + size;
    }
}

fn set_work_field(dictionary: &mut [u8], name: u8, replacement: &[u8]) {
    let mut pos = 2;
    loop {
        assert_ne!(
            dictionary[pos], 0,
            "genuine Argon writer must provide field"
        );
        let key_len = read_len(&dictionary[pos + 1..pos + 5]);
        let key_start = pos + 5;
        let len_start = key_start + key_len;
        let value_len = read_len(&dictionary[len_start..len_start + 4]);
        let value_start = len_start + 4;
        if dictionary[key_start..len_start] == [name] {
            assert_eq!(value_len, replacement.len());
            dictionary[value_start..value_start + value_len].copy_from_slice(replacement);
            return;
        }
        pos = value_start + value_len;
    }
}

#[test]
fn genuine_argon_headers_refuse_individual_and_joint_work_before_import() {
    for (memory, passes, lanes, reason) in [
        ((128u64 << 20) + 1, 1u64, 1u32, "memory cost"),
        (64 << 10, 9, 1, "iteration count"),
        (64 << 10, 1, 9, "parallelism"),
        (128 << 20, 4, 1, "KDF work"),
        (64 << 10, 8, 5, "KDF lane work"),
    ] {
        let mut bytes = build_weak_bytes();
        let dictionary = kdf_dictionary(&mut bytes);
        set_work_field(dictionary, b'M', &memory.to_le_bytes());
        set_work_field(dictionary, b'I', &passes.to_le_bytes());
        set_work_field(dictionary, b'P', &lanes.to_le_bytes());
        // An exact resource refusal proves the screen ran before the now-stale
        // public header hash. This is not an accepted-work timing benchmark.
        refuses_without_writes(&bytes, reason);
    }
}
