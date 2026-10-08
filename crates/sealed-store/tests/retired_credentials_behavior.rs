//! Public owner/decoy semantics using generated encrypted stores and real proofs.

#![cfg(any(unix, windows))]

use opensesame_human_vault::retired_credentials::Response;
use opensesame_sealed_store::retired_credentials::{
    admit_store_read, classify_retired_password, clear_retired_events, enroll_retired_password,
    has_retired_traps, remove_retired_password, retired_records_for_owner, ReadAdmission,
    RETIRED_RECORD_FILE,
};
use opensesame_sealed_store::{init_store, init_store_key, protect_rewrap_store_password, Entry};

#[test]
fn foreign_store_records_refuse_then_original_owner_and_records_recover() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    init_store(first.path(), &[]).unwrap();
    let second_store = init_store(second.path(), &[]).unwrap();
    init_store_key(first.path(), b"generated-owner-one").unwrap();
    let second_key = init_store_key(second.path(), b"generated-owner-two").unwrap();
    second_store
        .insert(
            "Owner/private",
            &Entry::parse("generated-second-secret\n"),
            &second_key,
        )
        .unwrap();
    enroll_retired_password(
        first.path(),
        b"generated-owner-one",
        b"generated-retired-one",
        Response::Reject,
    )
    .unwrap();
    enroll_retired_password(
        second.path(),
        b"generated-owner-two",
        b"generated-retired-two",
        Response::Reject,
    )
    .unwrap();
    let foreign = std::fs::read(first.path().join(RETIRED_RECORD_FILE)).unwrap();
    let original = std::fs::read(second.path().join(RETIRED_RECORD_FILE)).unwrap();
    let key_before = std::fs::read(second.path().join(".opensesame-key")).unwrap();
    std::fs::write(second.path().join(RETIRED_RECORD_FILE), foreign).unwrap();
    assert!(has_retired_traps(second.path()).is_err());
    assert!(retired_records_for_owner(second.path(), b"generated-owner-two").is_err());
    assert!(classify_retired_password(second.path(), b"generated-retired-one").is_err());
    std::fs::write(second.path().join(RETIRED_RECORD_FILE), original).unwrap();
    let ReadAdmission::Real(key) = admit_store_read(second.path(), b"generated-owner-two").unwrap()
    else {
        panic!("fresh original owner refused after its metadata was restored");
    };
    assert_eq!(
        second_store.show("Owner/private", &key).unwrap().secret,
        "generated-second-secret"
    );
    assert_eq!(
        std::fs::read(second.path().join(".opensesame-key")).unwrap(),
        key_before
    );
}

#[test]
fn synthetic_principals_are_independent_and_prefixes_never_select_real_data() {
    let directory = tempfile::tempdir().unwrap();
    let store = init_store(directory.path(), &[]).unwrap();
    let key = init_store_key(directory.path(), b"generated-owner").unwrap();
    store
        .insert(
            "Owner/private",
            &Entry::parse("generated-owner-secret\n"),
            &key,
        )
        .unwrap();
    enroll_retired_password(
        directory.path(),
        b"generated-owner",
        b"generated-retired",
        Response::SyntheticDecoy,
    )
    .unwrap();
    let first = admit_store_read(directory.path(), b"generated-retired").unwrap();
    let second = admit_store_read(directory.path(), b"generated-retired").unwrap();
    let (ReadAdmission::Synthetic(first), ReadAdmission::Synthetic(second)) = (first, second)
    else {
        panic!("retired password received a real item key");
    };
    assert!(uuid::Uuid::parse_str(first.principal()).is_ok());
    assert!(uuid::Uuid::parse_str(second.principal()).is_ok());
    assert_ne!(first.principal(), second.principal());
    for prefix in ["", "Example", "Example/account"] {
        assert_eq!(first.names(prefix), vec!["Example/account"]);
    }
    for prefix in ["Owner", "Exam", "Example/account/child", "different"] {
        assert!(first.names(prefix).is_empty());
    }
    assert!(first.show("Owner/private").is_err());
    assert!(!first
        .show("Example/account")
        .unwrap()
        .contains("generated-owner-secret"));
    assert_ne!(
        first.show("Example/account").unwrap(),
        second.show("Example/account").unwrap()
    );
    assert!(first.production_authority().is_err());
    let ReadAdmission::Real(owner) =
        admit_store_read(directory.path(), b"generated-owner").unwrap()
    else {
        panic!("fresh owner was denied");
    };
    assert_eq!(
        store.show("Owner/private", &owner).unwrap().secret,
        "generated-owner-secret"
    );
}

#[test]
fn evidence_clear_requires_current_owner_and_keeps_traps_and_root_intact() {
    let directory = tempfile::tempdir().unwrap();
    init_store(directory.path(), &[]).unwrap();
    init_store_key(directory.path(), b"generated-owner").unwrap();
    assert!(!has_retired_traps(directory.path()).unwrap());
    let trap = enroll_retired_password(
        directory.path(),
        b"generated-owner",
        b"generated-retired",
        Response::Reject,
    )
    .unwrap();
    assert!(has_retired_traps(directory.path()).unwrap());
    assert!(
        classify_retired_password(directory.path(), b"generated-retired")
            .unwrap()
            .is_some()
    );
    assert!(
        !retired_records_for_owner(directory.path(), b"generated-owner")
            .unwrap()
            .events
            .is_empty()
    );
    protect_rewrap_store_password(
        directory.path(),
        b"generated-owner",
        b"generated-next-owner",
    )
    .unwrap();
    let key_before = std::fs::read(directory.path().join(".opensesame-key")).unwrap();
    let evidence_before = std::fs::read(directory.path().join(RETIRED_RECORD_FILE)).unwrap();
    for denied in [
        b"generated-owner".as_slice(),
        b"generated-retired".as_slice(),
        b"wrong-owner".as_slice(),
    ] {
        assert!(clear_retired_events(directory.path(), denied).is_err());
        assert_eq!(
            std::fs::read(directory.path().join(RETIRED_RECORD_FILE)).unwrap(),
            evidence_before
        );
    }
    clear_retired_events(directory.path(), b"generated-next-owner").unwrap();
    let cleared = retired_records_for_owner(directory.path(), b"generated-next-owner").unwrap();
    assert!(cleared.events.is_empty());
    assert_eq!(cleared.traps, vec![trap.clone()]);
    assert!(has_retired_traps(directory.path()).unwrap());
    assert_eq!(
        std::fs::read(directory.path().join(".opensesame-key")).unwrap(),
        key_before
    );
    remove_retired_password(directory.path(), b"generated-next-owner", &trap.id).unwrap();
    assert!(!has_retired_traps(directory.path()).unwrap());
}
