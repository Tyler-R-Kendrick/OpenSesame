//! Public native API regression controls for measured adapter mutation survivors.
#[path = "support/native_canary_adapters.rs"]
mod support;
use opensesame_authenticator_core::{
    native_canaries::{
        native_canary_dispatch_current, native_canary_finish, native_canary_manage,
        native_canary_reserve, native_canary_retire_issued, native_canary_status,
        NativeCanaryMutation,
    },
    retired_gate::NativeGateError,
};
use opensesame_human_vault::credential_canaries::{
    receiver::{acknowledge, Reservation},
    CreatedArtifact, MAX_ARTIFACTS,
};
use std::sync::Arc;
use support::{
    gate, manage, padded_json, populated_state, provision, retirement, Issuer, NOW, OWNER,
};

#[test]
fn native_issuer_capacity_and_duplicate_refuse_before_authenticated_provider_io() {
    let (gate, identity) = gate();
    let artifact = retirement(&identity);
    let provider = Arc::new(Issuer::new(
        &artifact,
        serde_json::to_string(&artifact).unwrap(),
    ));
    let full = populated_state(&identity, MAX_ARTIFACTS);
    assert!(matches!(
        native_canary_retire_issued(
            gate.clone(),
            OWNER.into(),
            Some(full.encode().unwrap()),
            artifact.id.clone(),
            provider.clone(),
            NOW.into(),
        ),
        Err(NativeGateError::EnrollmentRefused)
    ));
    assert_eq!(
        provider.calls(),
        0,
        "Full inventory must not dispatch issuer revocation"
    );

    let mut duplicate = populated_state(&identity, 0);
    duplicate
        .registry
        .import_verified_retirement(&artifact.id, artifact.clone())
        .unwrap();
    assert!(matches!(
        native_canary_retire_issued(
            gate.clone(),
            OWNER.into(),
            Some(duplicate.encode().unwrap()),
            artifact.id.clone(),
            provider.clone(),
            NOW.into(),
        ),
        Err(NativeGateError::EnrollmentRefused)
    ));
    assert_eq!(
        provider.calls(),
        0,
        "Duplicate must be refused before issuer revocation"
    );

    // Nonempty inventory with a DIFFERENT artifact is a genuine accepted control.
    let valid = populated_state(&identity, 1);
    let imported = native_canary_retire_issued(
        gate.clone(),
        OWNER.into(),
        Some(valid.encode().unwrap()),
        artifact.id.clone(),
        provider.clone(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(provider.calls(), 1);
    let status: serde_json::Value =
        serde_json::from_str(&native_canary_status(gate, Some(imported.state_record)).unwrap())
            .unwrap();
    assert_eq!(status["artifacts"].as_array().unwrap().len(), 2);
    assert!(status["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == artifact.id));
}

#[test]
fn native_issuer_accepts_exact_response_limit_and_refuses_one_extra_byte() {
    let (gate, identity) = gate();
    let artifact = retirement(&identity);
    let raw = serde_json::to_string(&artifact).unwrap();
    let exact = Arc::new(Issuer::new(&artifact, padded_json(&raw, 4096)));
    let imported = native_canary_retire_issued(
        gate.clone(),
        OWNER.into(),
        None,
        artifact.id.clone(),
        exact.clone(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(exact.calls(), 1);
    assert!(native_canary_status(gate.clone(), Some(imported.state_record)).is_ok());

    // Over-limit data remains valid JSON, isolating the real byte-boundary verdict.
    let oversized = Arc::new(Issuer::new(&artifact, padded_json(&raw, 4097)));
    assert!(matches!(
        native_canary_retire_issued(
            gate,
            OWNER.into(),
            None,
            artifact.id,
            oversized.clone(),
            NOW.into(),
        ),
        Err(NativeGateError::InvalidRecord)
    ));
    assert_eq!(oversized.calls(), 1);
}

#[test]
fn native_delivery_reservation_exact_limit_preserves_authentic_ack_admission() {
    let (gate, _) = gate();
    let provision = provision();
    let configured = manage(
        &gate,
        None,
        NativeCanaryMutation::ConfigureReceiver {
            provision: serde_json::to_string(&provision).unwrap(),
        },
    );
    let queued = manage(
        &gate,
        Some(configured.state_record),
        NativeCanaryMutation::TestReceiver,
    );
    let reserved = native_canary_reserve(
        gate.clone(),
        queued.state_record,
        Some(queued.output),
        true,
        NOW.into(),
    )
    .unwrap()
    .unwrap();
    let exact = padded_json(&reserved.reservation, 16384);
    let oversized = padded_json(&reserved.reservation, 16385);
    assert!(native_canary_dispatch_current(
        gate.clone(),
        reserved.state_record.clone(),
        exact.clone(),
        NOW.into(),
    )
    .unwrap());
    assert!(matches!(
        native_canary_dispatch_current(
            gate.clone(),
            reserved.state_record.clone(),
            oversized.clone(),
            NOW.into(),
        ),
        Err(NativeGateError::InvalidRecord)
    ));
    let packet: Reservation = serde_json::from_str(&reserved.reservation).unwrap();
    let ack = acknowledge(
        &packet.packet,
        &provision,
        chrono::DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&chrono::Utc),
    )
    .unwrap();
    let acknowledgement = serde_json::to_string(&ack).unwrap();
    assert!(matches!(
        native_canary_finish(
            gate.clone(),
            reserved.state_record.clone(),
            oversized,
            Some(acknowledgement.clone()),
            NOW.into(),
        ),
        Err(NativeGateError::InvalidRecord)
    ));
    let finished = native_canary_finish(
        gate.clone(),
        reserved.state_record,
        exact,
        Some(acknowledgement),
        NOW.into(),
    )
    .unwrap();
    assert!(finished.delivered);
    let enabled = manage(
        &gate,
        Some(finished.state_record),
        NativeCanaryMutation::EnableReceiver { enabled: true },
    );
    assert!(native_canary_status(gate, Some(enabled.state_record)).is_ok());
}

#[test]
fn native_owner_remove_deletes_only_selected_artifact_after_fresh_owner_proof() {
    let (gate, _) = gate();
    let first = manage(
        &gate,
        None,
        NativeCanaryMutation::Create {
            kind: "mcp_configuration".into(),
        },
    );
    let selected: CreatedArtifact = serde_json::from_str(&first.output).unwrap();
    let second = manage(
        &gate,
        Some(first.state_record),
        NativeCanaryMutation::Create {
            kind: "connection_ref".into(),
        },
    );
    let other: CreatedArtifact = serde_json::from_str(&second.output).unwrap();
    assert!(native_canary_manage(
        gate.clone(),
        "wrong public owner fixture".into(),
        Some(second.state_record.clone()),
        NativeCanaryMutation::Remove {
            artifact_id: selected.id.clone()
        },
        NOW.into(),
    )
    .is_err());
    let removed = manage(
        &gate,
        Some(second.state_record),
        NativeCanaryMutation::Remove {
            artifact_id: selected.id.clone(),
        },
    );
    let status: serde_json::Value =
        serde_json::from_str(&native_canary_status(gate, Some(removed.state_record)).unwrap())
            .unwrap();
    let artifacts = status["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], other.id);
    assert!(artifacts
        .iter()
        .all(|artifact| artifact["id"] != selected.id));
}
