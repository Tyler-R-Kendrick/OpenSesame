//! Exact durable record-size limits through real public classification.

#![cfg(any(unix, windows))]

use opensesame_human_vault::retired_credentials::{
    DecoyAction, Records, Response, TrapEvent, MAX_RECORD_BYTES,
};
use opensesame_sealed_store::retired_credentials::{
    classify_retired_password, enroll_retired_password, retired_records_for_owner,
    RETIRED_RECORD_FILE,
};
use opensesame_sealed_store::{init_store, init_store_key};

fn sized_valid_history(mut records: Records, projected_size: usize) -> Vec<u8> {
    let long_date = format!("2026-10-05T12:00:00.{}Z", "0".repeat(43));
    assert_eq!(long_date.len(), 64);
    chrono::DateTime::parse_from_rfc3339(&long_date).unwrap();
    for (index, trap) in records.traps.iter_mut().enumerate() {
        trap.id = format!("{}{index}", "\0".repeat(127));
        trap.created_at.clone_from(&long_date);
    }
    // Publicly accepted historical IDs need not still be in the trap list.
    // Only fixture metadata changes; every verifier remains genuinely derived.
    records.events = vec![
        TrapEvent::SyntheticDecoyInteraction {
            trap_id: "\0".repeat(128),
            at: long_date,
            response: Response::SyntheticDecoy,
            action: DecoyAction::AuthorityDenied,
        };
        31
    ];
    let observed = TrapEvent::RetiredCredentialObserved {
        trap_id: records.traps[0].id.clone(),
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        response: records.traps[0].response,
    };
    let mut projected = records.clone();
    projected.events.push(observed.clone());
    let oversized = serde_json::to_vec(&projected).unwrap().len();
    assert!(oversized > MAX_RECORD_BYTES + 1);
    let mut remaining = oversized - projected_size;
    for event in records.events.iter_mut().rev() {
        if remaining == 0 {
            break;
        }
        let TrapEvent::SyntheticDecoyInteraction { trap_id, .. } = event else {
            panic!("fixture event type changed");
        };
        let reduction = remaining.min(767);
        let retained_id_length = 768 - reduction;
        let controls = (retained_id_length - 1) / 6;
        let ascii = retained_id_length - controls * 6;
        *trap_id = format!("{}{}", "\0".repeat(controls), "x".repeat(ascii));
        remaining -= reduction;
    }
    assert_eq!(remaining, 0);
    records.validate(&records.tomb).unwrap();
    let mut projected = records.clone();
    projected.events.push(observed);
    assert_eq!(
        serde_json::to_vec(&projected).unwrap().len(),
        projected_size
    );
    let before = serde_json::to_vec(&records).unwrap();
    assert!(before.len() < MAX_RECORD_BYTES);
    before
}

#[test]
fn accepted_size_commits_but_one_more_byte_preserves_last_durable_records() {
    let directory = tempfile::tempdir().unwrap();
    init_store(directory.path(), &[]).unwrap();
    init_store_key(directory.path(), b"generated-owner").unwrap();
    for (password, response) in [
        (b"generated-retired-one".as_slice(), Response::Reject),
        (b"generated-retired-two".as_slice(), Response::Reject),
        (
            b"generated-retired-three".as_slice(),
            Response::SyntheticDecoy,
        ),
    ] {
        enroll_retired_password(directory.path(), b"generated-owner", password, response).unwrap();
    }
    let authentic = retired_records_for_owner(directory.path(), b"generated-owner").unwrap();
    let key_before = std::fs::read(directory.path().join(".opensesame-key")).unwrap();
    for target in [MAX_RECORD_BYTES, MAX_RECORD_BYTES + 1] {
        let before = sized_valid_history(authentic.clone(), target);
        let initial =
            Records::parse(std::str::from_utf8(&before).unwrap(), &authentic.tomb).unwrap();
        std::fs::write(directory.path().join(RETIRED_RECORD_FILE), &before).unwrap();
        let result = classify_retired_password(directory.path(), b"generated-retired-one");
        let after = std::fs::read(directory.path().join(RETIRED_RECORD_FILE)).unwrap();
        if target == MAX_RECORD_BYTES {
            assert!(result.unwrap().is_some());
            assert_eq!(after.len(), MAX_RECORD_BYTES);
            let reopened = retired_records_for_owner(directory.path(), b"generated-owner").unwrap();
            assert_eq!(reopened.events.len(), 32);
            assert_eq!(reopened.traps, initial.traps);
            assert!(
                matches!(reopened.events.last(), Some(TrapEvent::RetiredCredentialObserved {
                trap_id, response: Response::Reject, ..
            }) if trap_id == &initial.traps[0].id)
            );
        } else {
            assert!(result.is_err());
            assert_eq!(after, before);
        }
        assert_eq!(
            std::fs::read(directory.path().join(".opensesame-key")).unwrap(),
            key_before
        );
    }
}
