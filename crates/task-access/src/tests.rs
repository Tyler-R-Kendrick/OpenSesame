use crate::{
    InMemoryTaskStore, ProposeRestrictionParams, RenewCredentialParams, SharedTaskStore,
    StartTaskParams, TaskAccessEngine, TaskAccessError, TaskStore,
};
use chrono::{Duration, Utc};
use opensesame_domain::{
    AuthorityContext, AuthorityContextId, AuthorityContextMode, Capability, CapabilitySet,
    CeilingInput, DomainError, EnforcementAcknowledgement, EnforcementAcknowledgementId,
    MediationPointId, OrganizationId, PrincipalId, ResourceSelector, TaskRunStatus, TaskTemplateId,
    VerificationEvidenceId,
};

fn cap(action: &str, resource: &str) -> Capability {
    Capability::new(action, ResourceSelector::exact(resource))
}

fn sample_context(principal: PrincipalId, ceiling: CapabilitySet) -> AuthorityContext {
    AuthorityContext {
        id: AuthorityContextId::new(),
        mode: AuthorityContextMode::SinglePrincipal,
        organization_id: OrganizationId::new(),
        project_id: None,
        principal_ids: vec![principal],
        capability_ceiling: ceiling,
        compiled_at: Utc::now(),
    }
}

fn start_sample_task(
    engine: &TaskAccessEngine<InMemoryTaskStore>,
    ceiling_caps: Vec<Capability>,
) -> opensesame_domain::TaskRun {
    start_sample_task_on(engine, ceiling_caps)
}

#[test]
fn a_ceiling_digest_cannot_be_rewritten_in_the_store() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a")]);
    let recorded = engine
        .store()
        .get_ceiling_digest(run.id)
        .unwrap()
        .expect("digest recorded at start");

    // Re-recording the same digest is a no-op, not a conflict.
    assert!(engine
        .store()
        .save_ceiling_digest(run.id, &recorded)
        .is_ok());

    // A different digest is refused at the store, not merely noticed on read:
    // an immutability that only holds on the read path is one stray writer away
    // from not holding at all.
    assert!(matches!(
        engine
            .store()
            .save_ceiling_digest(run.id, "sha256:some-wider-ceiling"),
        Err(TaskAccessError::CeilingImmutable)
    ));
    assert_eq!(
        engine.store().get_ceiling_digest(run.id).unwrap(),
        Some(recorded)
    );
}

#[test]
fn ceiling_immutability_after_start() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);

    let mut tampered = run.clone();
    tampered.capability_ceiling = CapabilitySet::new(vec![cap("admin", "repo:a")]);
    let err = engine.assert_ceiling_unchanged(&tampered).unwrap_err();
    assert_eq!(err, TaskAccessError::CeilingImmutable);
}

#[test]
fn renewal_after_ratchet_uses_new_state_version() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let mediation = MediationPointId::new();

    let transition = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![mediation],
            result_payload: None,
            now,
        })
        .unwrap();

    let ack = EnforcementAcknowledgement {
        id: EnforcementAcknowledgementId::new(),
        mediation_point_id: mediation,
        task_run_id: run.id,
        transition_id: transition.id.to_string(),
        state_version: transition.to_state_version,
        evidence_id: VerificationEvidenceId::new(),
        proof: None,
        acknowledged_at: now,
    };
    engine.acknowledge(transition.id, ack).unwrap();
    let updated = engine
        .commit_transition(run.id, transition.id, now)
        .unwrap();
    assert_eq!(updated.state_version, 2);

    let record = engine
        .renew_credential(RenewCredentialParams {
            task_run_id: run.id,
            expected_state_version: 2,
            credential_digest: "sha256:newcred".into(),
            expires_at: now + Duration::hours(1),
            now,
        })
        .unwrap();
    assert_eq!(record.state_version, 2);
    assert_eq!(record.credential_digest, "sha256:newcred");
}

#[test]
fn missing_ack_holds_result_buffer() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let mediation = MediationPointId::new();

    let transition = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![mediation],
            result_payload: Some(serde_json::json!({"status": "ok"})),
            now,
        })
        .unwrap();

    let buffer = engine.store().get_result_buffer(run.id).unwrap().unwrap();
    assert!(buffer.is_held());
    assert!(engine.release_result_buffer(run.id).is_err());

    let err = engine
        .commit_transition(run.id, transition.id, now)
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::MediationAckIncomplete)
    ));
}

#[test]
fn stale_version_rejected() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a")]);

    let err = engine
        .assert_capability(run.id, &cap("read", "repo:a"), 99, Utc::now())
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
    ));

    let now = Utc::now();
    let err2 = engine
        .renew_credential(RenewCredentialParams {
            task_run_id: run.id,
            expected_state_version: 0,
            credential_digest: "sha256:x".into(),
            expires_at: now + Duration::minutes(30),
            now,
        })
        .unwrap_err();
    assert!(matches!(
        err2,
        TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
    ));
}

#[test]
fn authority_context_switch_after_activation_fails() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a")]);

    let other = AuthorityContext {
        id: AuthorityContextId::new(),
        mode: AuthorityContextMode::SinglePrincipal,
        organization_id: run.organization_id,
        project_id: None,
        principal_ids: vec![run.principal_id],
        capability_ceiling: run.capability_ceiling.clone(),
        compiled_at: Utc::now(),
    };

    let err = engine
        .assert_authority_context_unchanged(&run, &other)
        .unwrap_err();
    assert_eq!(
        err,
        TaskAccessError::Domain(DomainError::AuthorityContextLocked)
    );
}

#[test]
fn commit_releases_result_buffer() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let mediation = MediationPointId::new();

    let transition = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![mediation],
            result_payload: Some(serde_json::json!({"done": true})),
            now,
        })
        .unwrap();

    let ack = EnforcementAcknowledgement {
        id: EnforcementAcknowledgementId::new(),
        mediation_point_id: mediation,
        task_run_id: run.id,
        transition_id: transition.id.to_string(),
        state_version: transition.to_state_version,
        evidence_id: VerificationEvidenceId::new(),
        proof: None,
        acknowledged_at: now,
    };
    engine.acknowledge(transition.id, ack).unwrap();
    engine
        .commit_transition(run.id, transition.id, now)
        .unwrap();

    let released = engine.release_result_buffer(run.id).unwrap();
    assert!(!released.is_held());
    assert_eq!(released.result_digest.len(), "sha256:".len() + 64);
}

#[test]
fn active_task_has_pending_status_during_restriction() {
    let store = InMemoryTaskStore::new();
    let engine = TaskAccessEngine::new(store);
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();

    engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![MediationPointId::new()],
            result_payload: None,
            now,
        })
        .unwrap();

    let restricting = engine.store().get_run(run.id).unwrap().unwrap();
    assert_eq!(restricting.status, TaskRunStatus::Restricting);
}

#[test]
fn multi_node_stale_commit_rejected_after_fencing() {
    let store = SharedTaskStore::new(InMemoryTaskStore::new());
    let node_a = TaskAccessEngine::new(store.clone());
    let node_b = TaskAccessEngine::new(store);
    let run = start_sample_task_on(&node_a, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let mediation = MediationPointId::new();

    let transition = node_a
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![mediation],
            result_payload: None,
            now,
        })
        .unwrap();

    let ack = EnforcementAcknowledgement {
        id: EnforcementAcknowledgementId::new(),
        mediation_point_id: mediation,
        task_run_id: run.id,
        transition_id: transition.id.to_string(),
        state_version: transition.to_state_version,
        evidence_id: VerificationEvidenceId::new(),
        proof: None,
        acknowledged_at: now,
    };
    node_a.acknowledge(transition.id, ack).unwrap();

    node_b
        .commit_transition(run.id, transition.id, now)
        .expect("node B commits first");

    let err = node_a
        .commit_transition(run.id, transition.id, now)
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
    ));
}

#[test]
fn save_run_cas_rejects_stale_version() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task_on(&engine, vec![cap("read", "repo:a")]);
    let mut bumped = engine.store().get_run(run.id).unwrap().unwrap();
    bumped.state_version = 2;
    bumped.updated_at = Utc::now();
    engine.store().save_run(&bumped).unwrap();

    bumped.state_version = 3;
    let err = engine.store().save_run_cas(&bumped, 1).unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::TaskStateVersionMismatch {
            expected: 1,
            actual: 2,
        })
    ));
}

#[test]
fn capability_assertion_expires_with_the_task() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task(&engine, vec![cap("read", "repo:a")]);

    // Inside the window the capability holds.
    engine
        .assert_capability(run.id, &cap("read", "repo:a"), 1, Utc::now())
        .expect("live task authorizes");

    let after = run.maximum_expires_at + Duration::seconds(1);
    let err = engine
        .assert_capability(run.id, &cap("read", "repo:a"), 1, after)
        .unwrap_err();
    assert_eq!(err, TaskAccessError::Domain(DomainError::TaskExpired));

    // Renewal past the deadline is refused for the same reason.
    let err = engine
        .renew_credential(RenewCredentialParams {
            task_run_id: run.id,
            expected_state_version: 1,
            credential_digest: "sha256:x".into(),
            expires_at: run.maximum_expires_at,
            now: after,
        })
        .unwrap_err();
    assert_eq!(err, TaskAccessError::Domain(DomainError::TaskExpired));
}

#[test]
fn superseded_result_buffer_stays_held_after_a_later_commit() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let mediation = MediationPointId::new();

    // Proposal A carries a payload and demands an acknowledgement it never gets.
    engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![mediation],
            result_payload: Some(serde_json::json!({"secret": "held"})),
            now,
        })
        .unwrap();

    // Proposal B supersedes it with no payload and no required acknowledgements.
    let b = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![],
            result_payload: None,
            now,
        })
        .unwrap();

    engine.commit_transition(run.id, b.id, now).unwrap();

    // A's payload was fenced by A's acknowledgements, which never arrived.
    assert!(engine.release_result_buffer(run.id).is_err());
    let buffer = engine.store().get_result_buffer(run.id).unwrap().unwrap();
    assert!(buffer.is_held());
}

fn start_sample_task_on<S: TaskStore>(
    engine: &TaskAccessEngine<S>,
    ceiling_caps: Vec<Capability>,
) -> opensesame_domain::TaskRun {
    let now = Utc::now();
    let principal = PrincipalId::new();
    let ceiling_set = CapabilitySet::new(ceiling_caps);
    let ctx = sample_context(principal, ceiling_set.clone());
    let compiled = engine
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: ceiling_set,
            }],
            now,
        )
        .unwrap();
    engine
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: ctx,
            ceiling: compiled,
            maximum_expires_at: now + Duration::hours(2),
            now,
        })
        .unwrap()
}
