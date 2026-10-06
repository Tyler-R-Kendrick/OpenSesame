use super::*;
use crate::{init_store, init_store_key, unlock_store_key};

#[cfg(unix)]
#[test]
fn hostile_record_nodes_sizes_and_concurrent_writers_fail_closed() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    init_store_key(dir.path(), b"owner current").unwrap();
    let record = dir.path().join(RETIRED_RECORD_FILE);
    symlink(dir.path().join("absent"), &record).unwrap();
    assert!(has_retired_traps(dir.path()).is_err());
    assert!(classify_retired_password(dir.path(), b"anything").is_err());
    std::fs::remove_file(&record).unwrap();
    std::fs::write(
        &record,
        vec![b'x'; opensesame_human_vault::retired_credentials::MAX_RECORD_BYTES + 1],
    )
    .unwrap();
    assert!(classify_retired_password(dir.path(), b"anything").is_err());
    let lock = StoreLock::key_file_edit(dir.path()).unwrap();
    assert!(classify_retired_password(dir.path(), b"anything").is_err());
    drop(lock);
    std::fs::remove_file(&record).unwrap();
    let path = std::ffi::CString::new(record.as_os_str().as_bytes()).unwrap();
    // SAFETY: owned NUL-terminated fixture path, private mode, no pointers retained.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert!(classify_retired_password(dir.path(), b"anything").is_err());
}

#[test]
fn native_decoy_read_never_issues_production_key_or_inherits_real_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"owner current").unwrap();
    root.insert(
        "Owner/private",
        &crate::Entry::parse("owner-only-secret\n"),
        &key,
    )
    .unwrap();
    let key_before = std::fs::read(dir.path().join(".opensesame-key")).unwrap();
    let trap = enroll_retired_password(
        dir.path(),
        b"owner current",
        b"selected retired",
        Response::SyntheticDecoy,
    )
    .unwrap();
    let admission = admit_store_read(dir.path(), b"selected retired").unwrap();
    let ReadAdmission::Synthetic(realm) = admission else {
        panic!("retired credential reached real authority");
    };
    assert_eq!(realm.names(""), vec!["Example/account"]);
    assert!(!realm
        .show("Example/account")
        .unwrap()
        .contains("owner-only-secret"));
    assert!(realm.show("Owner/private").is_err());
    assert!(realm.production_authority().is_err());
    assert!(unlock_store_key(dir.path(), b"selected retired").is_err());
    assert_eq!(
        std::fs::read(dir.path().join(".opensesame-key")).unwrap(),
        key_before
    );
    let records = retired_records_for_owner(dir.path(), b"owner current").unwrap();
    assert_eq!(records.traps[0].id, trap.id);
    assert_eq!(records.events.len(), 2);
    assert!(retired_records_for_owner(dir.path(), b"selected retired").is_err());
    let ReadAdmission::Real(real_key) = admit_store_read(dir.path(), b"owner current").unwrap()
    else {
        panic!("fresh owner denied");
    };
    assert!(root
        .show("Owner/private", &real_key)
        .unwrap()
        .render()
        .contains("owner-only-secret"));
}

#[test]
fn owner_selection_collisions_and_malformed_storage_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    init_store_key(dir.path(), b"owner current").unwrap();
    assert!(enroll_retired_password(dir.path(), b"wrong owner", b"old", Response::Reject).is_err());
    assert!(enroll_retired_password(
        dir.path(),
        b"owner current",
        b"owner current",
        Response::Reject
    )
    .is_err());
    let trap =
        enroll_retired_password(dir.path(), b"owner current", b"old", Response::Reject).unwrap();
    assert!(admit_store_read(dir.path(), b"old").is_err());
    assert!(crate::protect_rewrap_store_password(dir.path(), b"owner current", b"old").is_err());
    assert!(crate::rotate_store_root(
        dir.path(),
        b"owner current",
        opensesame_human_vault::root_protection::RotationEdit {
            new_password: Some(b"old"),
            ..Default::default()
        }
    )
    .is_err());
    remove_retired_password(dir.path(), b"owner current", &trap.id).unwrap();
    clear_retired_events(dir.path(), b"owner current").unwrap();
    assert!(retired_records_for_owner(dir.path(), b"owner current")
        .unwrap()
        .traps
        .is_empty());
    std::fs::write(dir.path().join(RETIRED_RECORD_FILE), b"{malformed}").unwrap();
    assert!(unlock_store_key(dir.path(), b"owner current").is_err());
}
