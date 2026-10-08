//! Windows positive persistence contracts; actual platform acceptance remains required.
#![cfg(windows)]
use opensesame_human_vault::retired_credentials::{Records, Response, MAX_RECORD_BYTES};
use opensesame_human_vault::{
    root_protection::{load_key_file, KeyFileContents},
    windows_io, windows_publish,
};
use opensesame_sealed_store::retired_credentials::{
    admit_store_read, classify_retired_password, clear_retired_events, enroll_retired_password,
    has_retired_traps, remove_retired_password, retired_records_for_owner, ReadAdmission,
    RETIRED_RECORD_FILE,
};
use opensesame_sealed_store::{init_store, init_store_key, unlock_store_key, Entry};
use std::path::Path;
use std::process::Command;

const OWNER: &[u8] = b"Windows current owner password";
const RETIRED: &[u8] = b"Windows retired synthetic password";
const REJECTED: &[u8] = b"Windows retired reject password";

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), OWNER).unwrap();
    store
        .insert("Owner/private", &Entry::parse("owner-only-secret\n"), &key)
        .unwrap();
    dir
}

#[test]
fn windows_positive_owner_lifecycle_keeps_synthetic_independent_and_reject_non_destructive() {
    let dir = fixture();
    let root = dir.path();
    let key_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    let item_before = std::fs::read(root.join("Owner/private.osseal")).unwrap();
    let synthetic =
        enroll_retired_password(root, OWNER, RETIRED, Response::SyntheticDecoy).unwrap();
    let rejected = enroll_retired_password(root, OWNER, REJECTED, Response::Reject).unwrap();
    assert!(has_retired_traps(root).unwrap());
    assert!(admit_store_read(root, REJECTED).is_err());
    let ReadAdmission::Synthetic(realm) = admit_store_read(root, RETIRED).unwrap() else {
        panic!("retired credential reached real realm");
    };
    assert_eq!(realm.names(""), vec!["Example/account"]);
    assert!(realm
        .show("Example/account")
        .unwrap()
        .starts_with("synthetic-"));
    assert!(realm.show("Owner/private").is_err());
    assert!(realm.production_authority().is_err());
    assert!(unlock_store_key(root, RETIRED).is_err());
    assert!(retired_records_for_owner(root, RETIRED).is_err());
    let records = retired_records_for_owner(root, OWNER).unwrap();
    assert!(!records.events.is_empty());
    let serialized = serde_json::to_string(&records).unwrap();
    assert!(!serialized.contains(std::str::from_utf8(RETIRED).unwrap()));
    assert!(!serialized.contains("owner-only-secret"));
    assert_eq!(
        std::fs::read(root.join(".opensesame-key")).unwrap(),
        key_before
    );
    assert_eq!(
        std::fs::read(root.join("Owner/private.osseal")).unwrap(),
        item_before
    );
    let ReadAdmission::Real(real) = admit_store_read(root, OWNER).unwrap() else {
        panic!("fresh owner could not return to real realm");
    };
    assert!(init_store(root, &[])
        .unwrap()
        .show("Owner/private", &real)
        .unwrap()
        .render()
        .contains("owner-only-secret"));
    remove_retired_password(root, OWNER, &synthetic.id).unwrap();
    remove_retired_password(root, OWNER, &rejected.id).unwrap();
    clear_retired_events(root, OWNER).unwrap();
    let cleared = retired_records_for_owner(root, OWNER).unwrap();
    assert!(cleared.traps.is_empty() && cleared.events.is_empty());
    assert!(!has_retired_traps(root).unwrap());
    assert!(admit_store_read(root, RETIRED).is_err());
}

#[test]
fn windows_positive_owner_selection_collisions_and_reuse_fail_without_record_mutation() {
    let dir = fixture();
    let root = dir.path();
    assert!(enroll_retired_password(root, b"wrong owner", RETIRED, Response::Reject).is_err());
    assert!(enroll_retired_password(root, OWNER, OWNER, Response::Reject).is_err());
    let trap = enroll_retired_password(root, OWNER, RETIRED, Response::SyntheticDecoy).unwrap();
    let before = std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap();
    assert!(enroll_retired_password(root, OWNER, RETIRED, Response::Reject).is_err());
    assert!(remove_retired_password(root, b"wrong owner", &trap.id).is_err());
    assert!(clear_retired_events(root, b"wrong owner").is_err());
    assert!(opensesame_sealed_store::protect_rewrap_store_password(root, OWNER, RETIRED).is_err());
    assert!(opensesame_sealed_store::rotate_store_root(
        root,
        OWNER,
        opensesame_human_vault::root_protection::RotationEdit {
            new_password: Some(RETIRED),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(
        std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap(),
        before
    );
    assert!(unlock_store_key(root, OWNER).is_ok());
}

#[test]
fn windows_positive_malformed_foreign_and_oversized_records_fail_closed() {
    let dir = fixture();
    let root = dir.path();
    let key_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    let mut foreign = Records::new("native-store:other-vault");
    foreign
        .enroll(RETIRED, Response::SyntheticDecoy, "2026-10-06T12:00:00Z")
        .unwrap();
    for bytes in [
        b"{malformed}".to_vec(),
        serde_json::to_vec(&foreign).unwrap(),
        vec![b'x'; MAX_RECORD_BYTES + 1],
    ] {
        windows_publish::atomic_write(root, Path::new(RETIRED_RECORD_FILE), &bytes).unwrap();
        assert!(has_retired_traps(root).is_err());
        assert!(classify_retired_password(root, RETIRED).is_err());
        assert!(admit_store_read(root, OWNER).is_err());
        assert!(unlock_store_key(root, OWNER).is_err());
        assert_eq!(
            std::fs::read(root.join(".opensesame-key")).unwrap(),
            key_before
        );
        assert_eq!(
            std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap(),
            bytes
        );
    }
}

#[test]
fn windows_positive_record_lock_and_hardlink_refuse_without_observation() {
    let dir = fixture();
    let root = dir.path();
    enroll_retired_password(root, OWNER, RETIRED, Response::SyntheticDecoy).unwrap();
    let before = std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap();
    let held = windows_io::lock(root, Path::new(".opensesame-lock"), true).unwrap();
    assert!(classify_retired_password(root, RETIRED).is_err());
    assert!(remove_retired_password(root, OWNER, "anything").is_err());
    drop(held);
    std::fs::hard_link(root.join(RETIRED_RECORD_FILE), root.join("linked-record")).unwrap();
    assert!(classify_retired_password(root, RETIRED).is_err());
    assert!(clear_retired_events(root, OWNER).is_err());
    assert_eq!(
        std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap(),
        before
    );
    std::fs::remove_file(root.join("linked-record")).unwrap();
    assert!(classify_retired_password(root, RETIRED).unwrap().is_some());
}

#[test]
fn windows_positive_junction_and_readable_record_acl_refuse() {
    let dir = fixture();
    let root = dir.path();
    enroll_retired_password(root, OWNER, RETIRED, Response::SyntheticDecoy).unwrap();
    let before = std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let alias = outside.path().join("alias");
    assert!(Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&alias)
        .arg(root)
        .status()
        .unwrap()
        .success());
    assert!(classify_retired_password(&alias, RETIRED).is_err());
    assert_eq!(
        std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap(),
        before
    );
    assert!(Command::new("icacls.exe")
        .arg(root.join(RETIRED_RECORD_FILE))
        .args(["/grant", "*S-1-1-0:R"])
        .status()
        .unwrap()
        .success());
    assert!(classify_retired_password(root, RETIRED).is_err());
    assert!(admit_store_read(root, OWNER).is_err());
    assert_eq!(
        std::fs::read(root.join(RETIRED_RECORD_FILE)).unwrap(),
        before
    );
}

#[test]
fn windows_supported_store_without_traps_preserves_fresh_owner_and_rejects_unknown_passwords() {
    let dir = fixture();
    let root = dir.path();
    let key_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    let item_before = std::fs::read(root.join("Owner/private.osseal")).unwrap();
    assert!(!has_retired_traps(root).unwrap());
    assert!(classify_retired_password(root, RETIRED).unwrap().is_none());
    assert!(admit_store_read(root, RETIRED).is_err());
    assert!(unlock_store_key(root, RETIRED).is_err());
    assert!(matches!(
        admit_store_read(root, OWNER).unwrap(),
        ReadAdmission::Real(_)
    ));
    assert!(unlock_store_key(root, OWNER).is_ok());
    assert!(!root.join(RETIRED_RECORD_FILE).exists());
    assert_eq!(
        std::fs::read(root.join(".opensesame-key")).unwrap(),
        key_before
    );
    assert_eq!(
        std::fs::read(root.join("Owner/private.osseal")).unwrap(),
        item_before
    );
}

#[test]
fn safely_published_same_context_snapshot_retains_classification_without_real_authority() {
    let dir = fixture();
    let root = dir.path();
    let key_before = std::fs::read(root.join(".opensesame-key")).unwrap();
    let item_before = std::fs::read(root.join("Owner/private.osseal")).unwrap();
    let synthetic =
        enroll_retired_password(root, OWNER, RETIRED, Response::SyntheticDecoy).unwrap();
    let rejected = enroll_retired_password(root, OWNER, REJECTED, Response::Reject).unwrap();
    let snapshot = retired_records_for_owner(root, OWNER).unwrap();
    let KeyFileContents::Manifest(manifest) = load_key_file(root).unwrap() else {
        panic!("versioned owner fixture required");
    };
    let context = format!("native-store:{}", manifest.vault_id);
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    Records::parse(std::str::from_utf8(&bytes).unwrap(), &context).unwrap();
    remove_retired_password(root, OWNER, &synthetic.id).unwrap();
    remove_retired_password(root, OWNER, &rejected.id).unwrap();
    assert!(!has_retired_traps(root).unwrap());
    // Fixture restore uses the real private, confined atomic publisher, never raw file writes.
    windows_publish::atomic_write(root, Path::new(RETIRED_RECORD_FILE), &bytes).unwrap();
    assert!(has_retired_traps(root).unwrap());
    assert!(classify_retired_password(root, b"unknown password")
        .unwrap()
        .is_none());
    assert!(admit_store_read(root, REJECTED).is_err());
    let ReadAdmission::Synthetic(realm) = admit_store_read(root, RETIRED).unwrap() else {
        panic!("restored trap acquired a real principal");
    };
    assert!(realm.show("Owner/private").is_err());
    assert!(realm.production_authority().is_err());
    assert!(unlock_store_key(root, RETIRED).is_err());
    assert!(retired_records_for_owner(root, RETIRED).is_err());
    assert!(retired_records_for_owner(root, b"wrong owner").is_err());
    assert!(matches!(
        admit_store_read(root, OWNER).unwrap(),
        ReadAdmission::Real(_)
    ));
    assert_eq!(
        std::fs::read(root.join(".opensesame-key")).unwrap(),
        key_before
    );
    assert_eq!(
        std::fs::read(root.join("Owner/private.osseal")).unwrap(),
        item_before
    );
}
