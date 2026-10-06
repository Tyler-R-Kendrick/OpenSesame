mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}
use super::*;
use crate::retired_gate::{
    native_gate_admit, native_gate_change_password, native_gate_create, native_gate_enroll,
    NativeRealm,
};
use opensesame_human_vault::credential_canaries::{
    receiver::{acknowledge, Provision},
    CreatedArtifact,
};
const NOW: &str = "2026-10-06T00:00:00.000Z";
fn create(gate: &str, current: &str, state: Option<String>) -> NativeCanaryOwnerResult {
    native_canary_manage(
        gate.into(),
        current.into(),
        state,
        NativeCanaryMutation::Create {
            kind: "mcp_configuration".into(),
        },
        NOW.into(),
    )
    .unwrap()
}
#[test]
fn native_owner_uuid_migration_requires_current_password_and_survives_rotation() {
    let gate = native_gate_create("owner".into()).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&gate).unwrap();
    legacy.as_object_mut().unwrap().remove("vaultIdentity");
    let legacy = legacy.to_string();
    assert!(native_canary_manage(
        legacy.clone(),
        "wrong".into(),
        None,
        NativeCanaryMutation::ClearEvents,
        NOW.into()
    )
    .is_err());
    let result = create(&legacy, "owner", None);
    let identity = Gate::parse(&result.gate_record)
        .unwrap()
        .vault_identity
        .unwrap();
    let rotated =
        native_gate_change_password(result.gate_record, "owner".into(), "next".into()).unwrap();
    assert_eq!(
        Gate::parse(&rotated).unwrap().vault_identity.unwrap(),
        identity
    );
    assert!(native_canary_status(rotated, Some(result.state_record)).is_ok());
}
#[test]
fn native_canary_detection_never_admits_real_or_retired_owner_management() {
    let gate = native_gate_create("owner".into()).unwrap();
    let result = create(&gate, "owner", None);
    let artifact: CreatedArtifact = serde_json::from_str(&result.output).unwrap();
    let observed = native_canary_observe(
        result.gate_record.clone(),
        result.state_record.clone(),
        artifact.id.clone(),
        artifact.presented_id.clone(),
        "connected".into(),
        NOW.into(),
    )
    .unwrap();
    assert!(observed.observed);
    assert!(observed.decision.contains("synthetic_readonly"));
    assert_eq!(
        native_gate_admit(
            result.gate_record.clone(),
            artifact.presented_id,
            "2026-10-06T00:00:00.000Z".into()
        )
        .unwrap()
        .realm,
        NativeRealm::Rejected
    );
    let enrolled = native_gate_enroll(
        result.gate_record.clone(),
        "owner".into(),
        "old".into(),
        true,
        NOW.into(),
    )
    .unwrap();
    assert!(native_canary_manage(
        enrolled,
        "old".into(),
        Some(observed.state_record),
        NativeCanaryMutation::ClearEvents,
        NOW.into()
    )
    .is_err());
    let other = native_gate_create("owner".into()).unwrap();
    assert!(native_canary_status(other, Some(result.state_record)).is_err());
}
#[test]
fn native_receiver_test_and_revocation_require_exact_authenticated_current_binding() {
    let gate = native_gate_create("owner".into()).unwrap();
    let provision: Provision = serde_json::from_value(observation_vector::provision_json(
        &serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
        ))
        .unwrap(),
    ))
    .unwrap();
    let configured = native_canary_manage(
        gate,
        "owner".into(),
        None,
        NativeCanaryMutation::ConfigureReceiver {
            provision: serde_json::to_string(&provision).unwrap(),
        },
        NOW.into(),
    )
    .unwrap();
    assert!(native_canary_manage(
        configured.gate_record.clone(),
        "owner".into(),
        Some(configured.state_record.clone()),
        NativeCanaryMutation::EnableReceiver { enabled: true },
        NOW.into()
    )
    .is_err());
    let queued = native_canary_manage(
        configured.gate_record.clone(),
        "owner".into(),
        Some(configured.state_record),
        NativeCanaryMutation::TestReceiver,
        NOW.into(),
    )
    .unwrap();
    let reserved = native_canary_reserve(
        queued.gate_record.clone(),
        queued.state_record,
        Some(queued.output),
        true,
        NOW.into(),
    )
    .unwrap()
    .unwrap();
    assert!(native_canary_dispatch_current(
        queued.gate_record.clone(),
        reserved.state_record.clone(),
        reserved.reservation.clone(),
        NOW.into()
    )
    .unwrap());
    let reservation: opensesame_human_vault::credential_canaries::receiver::Reservation =
        serde_json::from_str(&reserved.reservation).unwrap();
    let ack = acknowledge(&reservation.packet, &provision, time(NOW).unwrap()).unwrap();
    let changed_gate = native_gate_change_password(
        queued.gate_record.clone(),
        "owner".into(),
        "next owner".into(),
    )
    .unwrap();
    assert!(!native_canary_dispatch_current(
        changed_gate.clone(),
        reserved.state_record.clone(),
        reserved.reservation.clone(),
        NOW.into()
    )
    .unwrap());
    let stale = native_canary_finish(
        changed_gate.clone(),
        reserved.state_record.clone(),
        reserved.reservation.clone(),
        Some(serde_json::to_string(&ack).unwrap()),
        NOW.into(),
    )
    .unwrap();
    assert!(!stale.delivered);
    assert!(native_canary_manage(
        changed_gate,
        "next owner".into(),
        Some(stale.state_record),
        NativeCanaryMutation::EnableReceiver { enabled: true },
        NOW.into()
    )
    .is_err());
    let finished = native_canary_finish(
        queued.gate_record.clone(),
        reserved.state_record.clone(),
        reserved.reservation.clone(),
        Some(serde_json::to_string(&ack).unwrap()),
        NOW.into(),
    )
    .unwrap();
    assert!(finished.delivered);
    let enabled = native_canary_manage(
        queued.gate_record.clone(),
        "owner".into(),
        Some(finished.state_record),
        NativeCanaryMutation::EnableReceiver { enabled: true },
        NOW.into(),
    )
    .unwrap();
    let removed = native_canary_manage(
        queued.gate_record.clone(),
        "owner".into(),
        Some(enabled.state_record),
        NativeCanaryMutation::RemoveReceiver,
        NOW.into(),
    )
    .unwrap();
    assert!(!native_canary_dispatch_current(
        queued.gate_record.clone(),
        removed.state_record.clone(),
        reserved.reservation.clone(),
        NOW.into()
    )
    .unwrap());
    assert!(
        native_canary_status(removed.gate_record, Some(removed.state_record))
            .unwrap()
            .contains("\"receiver\":null")
    );
}

#[test]
fn native_validator_export_records_only_closed_dispatch_metadata() {
    let gate = native_gate_create("owner".into()).unwrap();
    let created = create(&gate, "owner", None);
    let artifact: CreatedArtifact = serde_json::from_str(&created.output).unwrap();
    let exported = native_canary_manage(
        created.gate_record.clone(),
        "owner".into(),
        Some(created.state_record),
        NativeCanaryMutation::ExportValidator {
            artifact_id: artifact.id.clone(),
            presented_id: artifact.presented_id.clone(),
        },
        NOW.into(),
    )
    .unwrap();
    let status: serde_json::Value = serde_json::from_str(
        &native_canary_status(
            exported.gate_record.clone(),
            Some(exported.state_record.clone()),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(status["events"][0]["phase"], "artifact_dispatched");
    assert_eq!(status["events"][0]["artifactId"], artifact.id);
    assert!(!status.to_string().contains(&artifact.presented_id));
    assert!(!exported.output.contains(&artifact.presented_id));
    assert!(native_canary_manage(
        exported.gate_record,
        "owner".into(),
        Some(exported.state_record),
        NativeCanaryMutation::ExportValidator {
            artifact_id: artifact.id,
            presented_id: "invalid".into(),
        },
        NOW.into(),
    )
    .is_err());
}

#[test]
fn trusted_issuer_import_requires_fresh_owner_and_original_issued_context() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Provider {
        metadata: String,
        calls: AtomicUsize,
        expected: String,
    }
    impl NativeCanaryIssuerProvider for Provider {
        fn retire_authenticated(
            &self,
            _record: String,
            identity: String,
        ) -> Result<String, NativeGateError> {
            assert_eq!(identity, self.expected);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.metadata.clone())
        }
    }
    let gate = native_gate_create("owner".into()).unwrap();
    let identity = Gate::parse(&gate).unwrap().vault_identity.unwrap();
    let issuer_ref = uuid::Uuid::new_v4().to_string();
    let context = opensesame_human_vault::credential_canaries::ArtifactContext {
        vault_identity: identity.clone(),
        kind: opensesame_human_vault::credential_canaries::ArtifactKind::ConnectionRef,
        generation: 1,
    };
    let mut registry =
        opensesame_human_vault::credential_canaries::Registry::new("issuer", &identity);
    let presented = opensesame_human_vault::credential_canaries::mint_presented_id();
    let mut artifact = registry
        .register_verified_retired(&context, &presented, NOW)
        .unwrap();
    artifact.id = issuer_ref.clone();
    let provider = Arc::new(Provider {
        metadata: serde_json::to_string(&artifact).unwrap(),
        calls: AtomicUsize::new(0),
        expected: identity,
    });
    assert!(native_canary_retire_issued(
        gate.clone(),
        "wrong".into(),
        None,
        issuer_ref.clone(),
        provider.clone(),
        NOW.into()
    )
    .is_err());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    let imported = native_canary_retire_issued(
        gate.clone(),
        "owner".into(),
        None,
        issuer_ref.clone(),
        provider.clone(),
        NOW.into(),
    )
    .unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(!imported.state_record.contains(&presented));
    let observed = native_canary_observe(
        gate.clone(),
        imported.state_record.clone(),
        issuer_ref.clone(),
        presented.clone(),
        "retired_generation_observed".into(),
        NOW.into(),
    )
    .unwrap();
    assert!(observed.observed && observed.decision.contains("reject"));
    assert_eq!(
        native_gate_admit(gate.clone(), presented, NOW.into())
            .unwrap()
            .realm,
        NativeRealm::Rejected
    );
    assert!(native_canary_retire_issued(
        gate.clone(),
        "owner".into(),
        Some(imported.state_record),
        issuer_ref.clone(),
        provider,
        NOW.into()
    )
    .is_err());
    artifact.context.vault_identity = uuid::Uuid::new_v4().to_string();
    let wrong = Arc::new(Provider {
        metadata: serde_json::to_string(&artifact).unwrap(),
        calls: AtomicUsize::new(0),
        expected: Gate::parse(&gate).unwrap().vault_identity.unwrap(),
    });
    assert!(
        native_canary_retire_issued(gate, "owner".into(), None, issuer_ref, wrong, NOW.into())
            .is_err()
    );
}
