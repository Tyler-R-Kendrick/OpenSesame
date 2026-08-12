use crate::{
    InMemoryTaskStore, ProposeRestrictionParams, RenewCredentialParams, SharedTaskStore,
    StartTaskParams, TaskAccessEngine, TaskAccessError, TaskStore,
};
use chrono::{Duration, Utc};
use opensesame_domain::{
    AuthorityContext, AuthorityContextId, AuthorityContextMode, Capability, CapabilitySet,
    CapabilityStateTransitionId, CeilingInput, DomainError, EnforcementAcknowledgement,
    EnforcementAcknowledgementId, MediationPointId, OrganizationId, PrincipalId, ResourceSelector,
    TaskRunStatus, TaskTemplateId, VerificationEvidenceId,
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
        .assert_capability(run.id, &cap("read", "repo:a"), 99)
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

/// A proposed restriction withdraws what it removes straight away: enforcers must
/// see the shrink before anything irreversible happens under the wider set.
#[test]
fn pending_restriction_withdraws_its_removals() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
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

    // Still held, so still usable.
    engine
        .assert_capability(run.id, &cap("read", "repo:a"), 1)
        .expect("a retained capability keeps working");

    let err = engine
        .assert_capability(run.id, &cap("write", "repo:a"), 1)
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::AuthorizationDenied(_))
    ));
}

/// One restriction at a time: a no-op shrink needing no acknowledgement must not
/// take over from one that is still waiting for a mediator.
#[test]
fn second_proposal_cannot_supersede_a_pending_one() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();

    let first = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![MediationPointId::new()],
            result_payload: None,
            now,
        })
        .unwrap();

    let err = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: run.current_capabilities.clone(),
            required_mediation: vec![],
            result_payload: None,
            now,
        })
        .unwrap_err();
    assert!(matches!(err, TaskAccessError::TransitionPending(_)));

    let pending = engine
        .store()
        .get_pending_transition(run.id)
        .unwrap()
        .unwrap();
    assert_eq!(pending.id, first.id);
}

/// An acknowledgement settles the transition it names, not another one that
/// happens to land on the same state version.
#[test]
fn ack_naming_another_transition_is_refused() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
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

    let err = engine
        .acknowledge(
            transition.id,
            EnforcementAcknowledgement {
                id: EnforcementAcknowledgementId::new(),
                mediation_point_id: mediation,
                task_run_id: run.id,
                // Same run, same version, different transition.
                transition_id: CapabilityStateTransitionId::new().to_string(),
                state_version: transition.to_state_version,
                evidence_id: VerificationEvidenceId::new(),
                proof: None,
                acknowledged_at: now,
            },
        )
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::MediationAckMismatch(_))
    ));
}

/// A proposal made against a version that has since moved on must not write
/// `restricting` over the newer state and roll the version back.
#[test]
fn propose_cannot_revive_a_terminated_task() {
    let store = SharedTaskStore::new(InMemoryTaskStore::new());
    let node_a = TaskAccessEngine::new(store.clone());
    let node_b = TaskAccessEngine::new(store);
    let run = start_sample_task_on(&node_a, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();

    node_b.terminate_task(run.id, 1, now).unwrap();

    let err = node_a
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![MediationPointId::new()],
            result_payload: None,
            now,
        })
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::TaskNotActive)
            | TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
    ));

    let after = node_a.store().get_run(run.id).unwrap().unwrap();
    assert_eq!(after.status, TaskRunStatus::Cancelled);
    assert_eq!(after.state_version, 2);
}

/// Two answers from one mediator are still one mediator: the other point has to
/// fence before capabilities move.
#[test]
fn repeat_ack_does_not_stand_in_for_another_point() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let spoke = MediationPointId::new();
    let silent = MediationPointId::new();

    let transition = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![spoke, silent],
            result_payload: None,
            now,
        })
        .unwrap();

    let ack = |point| EnforcementAcknowledgement {
        id: EnforcementAcknowledgementId::new(),
        mediation_point_id: point,
        task_run_id: run.id,
        transition_id: transition.id.to_string(),
        state_version: transition.to_state_version,
        evidence_id: VerificationEvidenceId::new(),
        proof: None,
        acknowledged_at: now,
    };

    engine.acknowledge(transition.id, ack(spoke)).unwrap();
    // A second, distinct acknowledgement from the same point.
    let set = engine.acknowledge(transition.id, ack(spoke)).unwrap();
    assert_eq!(set.outstanding(), vec![silent]);

    let err = engine
        .commit_transition(run.id, transition.id, now)
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::MediationAckIncomplete)
    ));

    engine.acknowledge(transition.id, ack(silent)).unwrap();
    engine
        .commit_transition(run.id, transition.id, now)
        .expect("both points fenced");
}

/// A point this transition never asked for cannot settle it.
#[test]
fn ack_for_an_unrequired_point_is_refused() {
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let run = start_sample_task(&engine, vec![cap("read", "repo:a"), cap("write", "repo:a")]);
    let now = Utc::now();
    let required = MediationPointId::new();

    let transition = engine
        .propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            required_mediation: vec![required],
            result_payload: None,
            now,
        })
        .unwrap();

    let err = engine
        .acknowledge(
            transition.id,
            EnforcementAcknowledgement {
                id: EnforcementAcknowledgementId::new(),
                mediation_point_id: MediationPointId::new(),
                task_run_id: run.id,
                transition_id: transition.id.to_string(),
                state_version: transition.to_state_version,
                evidence_id: VerificationEvidenceId::new(),
                proof: None,
                acknowledged_at: now,
            },
        )
        .unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::MediationAckMismatch(_))
    ));
}

/// Cancelling is a decision about a state, so it must not land on a later one:
/// a stale terminate would restore capabilities a commit had removed.
#[test]
fn terminate_cannot_overwrite_a_commit_it_did_not_see() {
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
    node_a
        .acknowledge(
            transition.id,
            EnforcementAcknowledgement {
                id: EnforcementAcknowledgementId::new(),
                mediation_point_id: mediation,
                task_run_id: run.id,
                transition_id: transition.id.to_string(),
                state_version: transition.to_state_version,
                evidence_id: VerificationEvidenceId::new(),
                proof: None,
                acknowledged_at: now,
            },
        )
        .unwrap();
    node_b
        .commit_transition(run.id, transition.id, now)
        .expect("the restriction lands");

    // Node A still believes the run is at version 1.
    let err = node_a.terminate_task(run.id, 1, now).unwrap_err();
    assert!(matches!(
        err,
        TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
    ));
    let after = node_a.store().get_run(run.id).unwrap().unwrap();
    assert_eq!(after.status, TaskRunStatus::Active);
    assert_eq!(after.state_version, 2);

    node_b
        .terminate_task(run.id, 2, now)
        .expect("terminate from the version it read");
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
