use super::*;

const NOW: &str = "2026-10-05T12:00:00.000Z";

#[test]
fn native_application_password_lifecycle_cannot_restore_retired_authority() {
    let initial = native_gate_create("former application password".into()).unwrap();
    let rotated = native_gate_change_password(
        initial,
        "former application password".into(),
        "current application password".into(),
    )
    .unwrap();
    assert_eq!(
        native_gate_admit(
            rotated.clone(),
            "former application password".into(),
            NOW.into()
        )
        .unwrap()
        .realm,
        NativeRealm::Rejected
    );
    let record = native_gate_enroll(
        rotated.clone(),
        "current application password".into(),
        "former application password".into(),
        false,
        NOW.into(),
    )
    .unwrap();
    let rejected = native_gate_admit(
        record.clone(),
        "former application password".into(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(rejected.realm, NativeRealm::Rejected);
    let status: serde_json::Value =
        serde_json::from_str(&native_gate_status(rejected.record.clone()).unwrap()).unwrap();
    assert_eq!(status["events"].as_array().unwrap().len(), 1);
    assert!(!status.to_string().contains("verifier"));
    assert!(!status.to_string().contains("salt"));
    assert!(!status.to_string().contains("former application password"));
    assert!(native_gate_enroll(
        record.clone(),
        "current application password".into(),
        "current application password".into(),
        true,
        NOW.into()
    )
    .is_err());
    assert!(native_gate_change_password(
        record.clone(),
        "current application password".into(),
        "former application password".into()
    )
    .is_err());
    assert!(
        native_gate_clear_events(record.clone(), "former application password".into()).is_err()
    );
    let id = status["traps"][0]["id"].as_str().unwrap().to_string();
    let record = native_gate_remove(record, "current application password".into(), id).unwrap();
    let record = native_gate_enroll(
        record,
        "current application password".into(),
        "former application password".into(),
        true,
        NOW.into(),
    )
    .unwrap();
    let decoy = native_gate_admit(
        record.clone(),
        "former application password".into(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(decoy.realm, NativeRealm::Synthetic);
    assert_eq!(
        native_gate_admit(
            decoy.record,
            "current application password".into(),
            NOW.into()
        )
        .unwrap()
        .realm,
        NativeRealm::Real
    );
    assert_eq!(
        native_gate_admit(record.clone(), "wrong guess".into(), NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Rejected
    );
    let record = native_gate_clear_events(record, "current application password".into()).unwrap();
    let status: serde_json::Value =
        serde_json::from_str(&native_gate_status(record).unwrap()).unwrap();
    assert!(status["events"].as_array().unwrap().is_empty());
}

#[test]
fn native_gate_refuses_corrupt_context_and_unbounded_records() {
    assert!(native_gate_admit("x".repeat(40_961), "guess".into(), NOW.into()).is_err());
    assert!(native_gate_create(String::new()).is_err());
    let record = native_gate_create("current password".into()).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&record).unwrap();
    value["records"]["tomb"] = serde_json::json!("different-wallet");
    assert!(native_gate_admit(value.to_string(), "current password".into(), NOW.into()).is_err());
    value["records"]["tomb"] = serde_json::json!(CONTEXT);
    value["unexpected"] = serde_json::json!(true);
    assert!(native_gate_status(value.to_string()).is_err());
}
