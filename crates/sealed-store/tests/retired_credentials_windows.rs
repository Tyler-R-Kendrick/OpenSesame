//! Windows currently refuses retained traps until a shared safe storage adapter exists.
#![cfg(windows)]

use opensesame_human_vault::retired_credentials::{Records, Response};
use opensesame_human_vault::root_protection::{
    load_key_file, unlock_key_file_with_password, KeyFileContents,
};
use opensesame_sealed_store::retired_credentials::{
    admit_store_read, classify_retired_password, clear_retired_events, enroll_retired_password,
    has_retired_traps, remove_retired_password, retired_records_for_owner, ReadAdmission,
    RETIRED_RECORD_FILE,
};
use opensesame_sealed_store::{init_store, init_store_key, unlock_store_key, StoreError};

const OWNER: &[u8] = b"Windows test current owner password";
const RETIRED: &[u8] = b"Windows test selected retired password";

fn unsupported<T>(result: Result<T, StoreError>) {
    let error = match result {
        Ok(_) => panic!("unsupported Windows trap storage admitted the operation"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("supported locking and confinement adapter"),
        "expected explicit storage refusal, got {error}"
    );
}

#[test]
fn windows_store_without_traps_preserves_existing_owner_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    init_store(root, &[]).unwrap();
    init_store_key(root, OWNER).unwrap();
    assert!(!has_retired_traps(root).unwrap());
    assert!(classify_retired_password(root, RETIRED).unwrap().is_none());
    assert!(matches!(
        admit_store_read(root, OWNER).unwrap(),
        ReadAdmission::Real(_)
    ));
    assert!(unlock_store_key(root, OWNER).is_ok());
}

#[test]
fn windows_enrollment_and_management_refuse_without_changing_the_real_key() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    init_store(root, &[]).unwrap();
    init_store_key(root, OWNER).unwrap();
    let key_file = root.join(".opensesame-key");
    let before = std::fs::read(&key_file).unwrap();
    unsupported(enroll_retired_password(
        root,
        OWNER,
        RETIRED,
        Response::SyntheticDecoy,
    ));
    unsupported(retired_records_for_owner(root, OWNER));
    unsupported(remove_retired_password(root, OWNER, "unknown-trap"));
    unsupported(clear_retired_events(root, OWNER));
    assert!(!root.join(RETIRED_RECORD_FILE).exists());
    assert_eq!(std::fs::read(key_file).unwrap(), before);
    assert!(unlock_store_key(root, OWNER).is_ok());
}

#[test]
fn windows_copied_valid_record_cannot_skip_classification_or_open_either_realm() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    init_store(root, &[]).unwrap();
    init_store_key(root, OWNER).unwrap();
    let KeyFileContents::Manifest(manifest) = load_key_file(root).unwrap() else {
        panic!("versioned fixture key required");
    };
    let context = format!("native-store:{}", manifest.vault_id);
    // The exact canonical format that a Unix owner may copy with a vault.
    // This fixture creates no production storage bypass or Windows enrollment path.
    let mut records = Records::new(&context);
    records
        .enroll(RETIRED, Response::SyntheticDecoy, "2026-10-06T12:00:00Z")
        .unwrap();
    let copied = serde_json::to_vec(&records).unwrap();
    Records::parse(std::str::from_utf8(&copied).unwrap(), &context).unwrap();
    let record_path = root.join(RETIRED_RECORD_FILE);
    std::fs::write(&record_path, &copied).unwrap();
    let key_file = root.join(".opensesame-key");
    let key_before = std::fs::read(&key_file).unwrap();
    unsupported(has_retired_traps(root));
    unsupported(classify_retired_password(root, RETIRED));
    unsupported(classify_retired_password(root, OWNER));
    unsupported(admit_store_read(root, RETIRED));
    unsupported(admit_store_read(root, OWNER));
    unsupported(unlock_store_key(root, OWNER));
    unsupported(retired_records_for_owner(root, OWNER));
    assert_eq!(std::fs::read(&record_path).unwrap(), copied);
    assert_eq!(std::fs::read(key_file).unwrap(), key_before);
    // Refusal did not change revocation or the underlying owner credential.
    assert!(unlock_key_file_with_password(root, OWNER).is_ok());
    assert!(unlock_key_file_with_password(root, RETIRED).is_err());
}
