//! Portable public gate behavior; this does not emulate OS owner verification.

use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_authenticator_core::retired_gate::{
    native_gate_admit, native_gate_authority_denied, native_gate_change_password,
    native_gate_create, native_gate_enroll, native_gate_remove, native_gate_status,
    NativeGateError, NativeRealm,
};
use serde_json::Value;

const OWNER: &str = "generated-current-application-password";
const NOW: &str = "2026-10-05T12:00:00.000Z";

fn status(record: &str) -> Value {
    serde_json::from_str(&native_gate_status(record.into()).unwrap()).unwrap()
}

fn mixed_gate() -> (String, String, String) {
    let gate = native_gate_create(OWNER.into()).unwrap();
    let gate = native_gate_enroll(
        gate,
        OWNER.into(),
        "generated-reject-password".into(),
        false,
        NOW.into(),
    )
    .unwrap();
    let gate = native_gate_enroll(
        gate,
        OWNER.into(),
        "generated-synthetic-password".into(),
        true,
        NOW.into(),
    )
    .unwrap();
    let view = status(&gate);
    let traps = view["traps"].as_array().unwrap();
    let id = |response: &str| {
        traps
            .iter()
            .find(|trap| trap["response"] == response)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    (gate, id("reject"), id("synthetic_decoy"))
}

#[test]
fn valid_record_size_boundary_and_independent_encoded_fields_fail_closed() {
    let record = native_gate_create(OWNER.into()).unwrap();
    let mut boundary = record.clone();
    boundary.push_str(&" ".repeat(40_960 - record.len()));
    assert_eq!(status(&boundary), status(&record));
    boundary.push(' ');
    assert!(matches!(
        native_gate_status(boundary),
        Err(NativeGateError::InvalidRecord)
    ));
    for (field, bad_bytes) in [("salt", vec![7_u8; 15]), ("verifier", vec![7_u8; 31])] {
        let mut damaged: Value = serde_json::from_str(&record).unwrap();
        damaged[field] = Value::String(STANDARD.encode(bad_bytes));
        assert!(matches!(
            native_gate_status(damaged.to_string()),
            Err(NativeGateError::InvalidRecord)
        ));
    }
    assert_eq!(
        native_gate_admit(record, OWNER.into(), NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Real
    );
}

#[test]
fn maximum_password_is_usable_but_empty_or_excess_rotation_is_refused() {
    let boundary = "a".repeat(1024);
    let initial = native_gate_create(boundary.clone()).unwrap();
    assert_eq!(
        native_gate_admit(initial, boundary.clone(), NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Real
    );
    for password in [String::new(), "a".repeat(1025)] {
        assert!(matches!(
            native_gate_create(password),
            Err(NativeGateError::EnrollmentRefused)
        ));
    }
    let gate = native_gate_create(OWNER.into()).unwrap();
    for next in [String::new(), "b".repeat(1025)] {
        assert!(matches!(
            native_gate_change_password(gate.clone(), OWNER.into(), next),
            Err(NativeGateError::EnrollmentRefused)
        ));
    }
    let rotated = native_gate_change_password(gate, OWNER.into(), boundary.clone()).unwrap();
    assert_eq!(
        native_gate_admit(rotated.clone(), OWNER.into(), NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Rejected
    );
    assert!(matches!(
        native_gate_enroll(
            rotated.clone(),
            OWNER.into(),
            "another-generated-old-password".into(),
            false,
            NOW.into()
        ),
        Err(NativeGateError::OwnerRequired)
    ));
    assert_eq!(
        native_gate_admit(rotated, boundary, NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Real
    );
}

#[test]
fn denied_authority_requires_the_exact_still_enrolled_synthetic_handle() {
    let (record, reject_id, synthetic_id) = mixed_gate();
    let synthetic = native_gate_admit(
        record.clone(),
        "generated-synthetic-password".into(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(synthetic.realm, NativeRealm::Synthetic);
    assert_eq!(
        native_gate_admit(
            record.clone(),
            "generated-reject-password".into(),
            NOW.into()
        )
        .unwrap()
        .realm,
        NativeRealm::Rejected
    );
    for id in [reject_id, "unknown-generated-handle".into()] {
        assert!(matches!(
            native_gate_authority_denied(record.clone(), id, NOW.into()),
            Err(NativeGateError::InvalidRecord)
        ));
    }
    assert!(matches!(
        native_gate_authority_denied(record.clone(), synthetic_id.clone(), "invalid-date".into()),
        Err(NativeGateError::InvalidRecord)
    ));
    let denied =
        native_gate_authority_denied(synthetic.record, synthetic_id.clone(), NOW.into()).unwrap();
    let view = status(&denied);
    let event = view["events"].as_array().unwrap().last().unwrap();
    assert_eq!(event["type"], "synthetic_decoy_interaction");
    assert_eq!(event["trapId"], synthetic_id);
    assert_eq!(event["response"], "synthetic_decoy");
    assert_eq!(event["action"], "authority_denied");
    assert!(!view.to_string().contains(OWNER));
    assert!(!view.to_string().contains("generated-synthetic-password"));
    let removed = native_gate_remove(denied, OWNER.into(), synthetic_id.clone()).unwrap();
    assert!(matches!(
        native_gate_authority_denied(removed.clone(), synthetic_id, NOW.into()),
        Err(NativeGateError::InvalidRecord)
    ));
    assert_eq!(
        native_gate_admit(removed, OWNER.into(), NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Real
    );
}

#[test]
fn denied_evidence_retains_the_last_thirty_two_in_order() {
    let (mut record, _, synthetic_id) = mixed_gate();
    for second in 1..=33 {
        let at = format!("2026-10-05T12:00:{second:02}.000Z");
        record = native_gate_authority_denied(record, synthetic_id.clone(), at).unwrap();
        let view = status(&record);
        let events = view["events"].as_array().unwrap();
        assert_eq!(events.len(), usize::min(second, 32));
        assert_eq!(events.last().unwrap()["trapId"], synthetic_id);
    }
    let view = status(&record);
    let events = view["events"].as_array().unwrap();
    assert_eq!(events[0]["at"], "2026-10-05T12:00:02.000Z");
    assert_eq!(events[31]["at"], "2026-10-05T12:00:33.000Z");
    assert_eq!(view["traps"].as_array().unwrap().len(), 2);
}
