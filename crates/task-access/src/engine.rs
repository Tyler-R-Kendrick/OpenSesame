use crate::credential::{ProtectedResultBuffer, TaskCredentialRecord};
use crate::TaskAccessError;
use chrono::{DateTime, Utc};
use opensesame_domain::{
    AcknowledgementSet, AuthorityContext, Capability, CapabilitySet, CapabilityStateTransition,
    CapabilityStateTransitionId, CapabilityTransitionStatus, CeilingCompilation, CeilingInput,
    DomainError, EnforcementAcknowledgement, MediationPointId, TaskRun, TaskRunId, TaskRunStatus,
    TaskTemplateId,
};
use std::collections::HashMap;

pub trait TaskStore: Send + Sync {
    fn get_run(&self, id: TaskRunId) -> Result<Option<TaskRun>, TaskAccessError>;
    fn save_run(&self, run: &TaskRun) -> Result<(), TaskAccessError>;
    /// Compare-and-swap persist: succeeds only when the stored row matches `expected_state_version`.
    fn save_run_cas(
        &self,
        run: &TaskRun,
        expected_state_version: u64,
    ) -> Result<(), TaskAccessError>;
    fn get_transition(
        &self,
        id: CapabilityStateTransitionId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError>;
    fn save_transition(
        &self,
        transition: &CapabilityStateTransition,
    ) -> Result<(), TaskAccessError>;
    fn get_pending_transition(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError>;
    fn get_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<AcknowledgementSet, TaskAccessError>;
    fn save_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
        set: &AcknowledgementSet,
    ) -> Result<(), TaskAccessError>;
    fn get_result_buffer(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<ProtectedResultBuffer>, TaskAccessError>;
    fn save_result_buffer(&self, buffer: &ProtectedResultBuffer) -> Result<(), TaskAccessError>;
    fn get_credential(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<TaskCredentialRecord>, TaskAccessError>;
    fn save_credential(&self, record: &TaskCredentialRecord) -> Result<(), TaskAccessError>;
    fn get_ceiling_digest(&self, task_run_id: TaskRunId)
        -> Result<Option<String>, TaskAccessError>;
    fn save_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
        digest: &str,
    ) -> Result<(), TaskAccessError>;
    fn set_pending_transition(
        &self,
        task_run_id: TaskRunId,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<(), TaskAccessError>;
    fn clear_pending_transition(&self, task_run_id: TaskRunId) -> Result<(), TaskAccessError>;
    fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError>;
}

fn lock_err() -> TaskAccessError {
    TaskAccessError::Domain(DomainError::Canonicalization("lock".into()))
}

fn lock_map<'a, K: Eq + std::hash::Hash, V>(
    map: &'a std::sync::Mutex<HashMap<K, V>>,
) -> Result<std::sync::MutexGuard<'a, HashMap<K, V>>, TaskAccessError> {
    map.lock().map_err(|_| lock_err())
}

#[derive(Debug, Default)]
pub struct InMemoryTaskStore {
    runs: std::sync::Mutex<HashMap<TaskRunId, TaskRun>>,
    transitions: std::sync::Mutex<HashMap<CapabilityStateTransitionId, CapabilityStateTransition>>,
    pending_by_run: std::sync::Mutex<HashMap<TaskRunId, CapabilityStateTransitionId>>,
    ack_sets: std::sync::Mutex<HashMap<CapabilityStateTransitionId, AcknowledgementSet>>,
    result_buffers: std::sync::Mutex<HashMap<TaskRunId, ProtectedResultBuffer>>,
    credentials: std::sync::Mutex<HashMap<TaskRunId, TaskCredentialRecord>>,
    ceiling_digests: std::sync::Mutex<HashMap<TaskRunId, String>>,
}

impl InMemoryTaskStore {
    pub const MAX_RUNS: usize = 512;

    pub fn new() -> Self {
        Self::default()
    }

    fn prune_expired(
        runs: &mut HashMap<TaskRunId, TaskRun>,
        now: DateTime<Utc>,
    ) {
        runs.retain(|_, run| run.maximum_expires_at > now);
    }
}

impl TaskStore for InMemoryTaskStore {
    fn get_run(&self, id: TaskRunId) -> Result<Option<TaskRun>, TaskAccessError> {
        Ok(lock_map(&self.runs)?.get(&id).cloned())
    }

    fn save_run(&self, run: &TaskRun) -> Result<(), TaskAccessError> {
        let mut runs = lock_map(&self.runs)?;
        Self::prune_expired(&mut runs, Utc::now());
        if !runs.contains_key(&run.id) && runs.len() >= Self::MAX_RUNS {
            return Err(TaskAccessError::Capacity);
        }
        runs.insert(run.id, run.clone());
        Ok(())
    }

    fn save_run_cas(
        &self,
        run: &TaskRun,
        expected_state_version: u64,
    ) -> Result<(), TaskAccessError> {
        let mut runs = lock_map(&self.runs)?;
        let Some(current) = runs.get(&run.id) else {
            return Err(TaskAccessError::TaskNotFound(run.id.to_string()));
        };
        if current.state_version != expected_state_version {
            return Err(TaskAccessError::Domain(
                DomainError::TaskStateVersionMismatch {
                    expected: expected_state_version,
                    actual: current.state_version,
                },
            ));
        }
        runs.insert(run.id, run.clone());
        Ok(())
    }

    fn get_transition(
        &self,
        id: CapabilityStateTransitionId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        Ok(lock_map(&self.transitions)?.get(&id).cloned())
    }

    fn save_transition(
        &self,
        transition: &CapabilityStateTransition,
    ) -> Result<(), TaskAccessError> {
        lock_map(&self.transitions)?.insert(transition.id, transition.clone());
        Ok(())
    }

    fn get_pending_transition(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        let pending = lock_map(&self.pending_by_run)?;
        let transitions = lock_map(&self.transitions)?;
        Ok(pending
            .get(&task_run_id)
            .and_then(|id| transitions.get(id).cloned()))
    }

    fn save_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
        set: &AcknowledgementSet,
    ) -> Result<(), TaskAccessError> {
        lock_map(&self.ack_sets)?.insert(transition_id, set.clone());
        Ok(())
    }

    fn get_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<AcknowledgementSet, TaskAccessError> {
        Ok(lock_map(&self.ack_sets)?
            .get(&transition_id)
            .cloned()
            .unwrap_or_default())
    }

    fn get_result_buffer(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<ProtectedResultBuffer>, TaskAccessError> {
        Ok(lock_map(&self.result_buffers)?.get(&task_run_id).cloned())
    }

    fn save_result_buffer(&self, buffer: &ProtectedResultBuffer) -> Result<(), TaskAccessError> {
        lock_map(&self.result_buffers)?.insert(buffer.task_run_id, buffer.clone());
        Ok(())
    }

    fn get_credential(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<TaskCredentialRecord>, TaskAccessError> {
        Ok(lock_map(&self.credentials)?.get(&task_run_id).cloned())
    }

    fn save_credential(&self, record: &TaskCredentialRecord) -> Result<(), TaskAccessError> {
        lock_map(&self.credentials)?.insert(record.task_run_id, record.clone());
        Ok(())
    }

    fn get_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<String>, TaskAccessError> {
        Ok(lock_map(&self.ceiling_digests)?.get(&task_run_id).cloned())
    }

    /// Write-once: a ceiling digest may be set, and may be set again to the same
    /// value, but never changed. Immutability that only holds on the read path is
    /// one stray writer away from not holding at all.
    fn save_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
        digest: &str,
    ) -> Result<(), TaskAccessError> {
        let mut digests = lock_map(&self.ceiling_digests)?;
        match digests.get(&task_run_id) {
            Some(existing) if existing != digest => Err(TaskAccessError::CeilingImmutable),
            Some(_) => Ok(()),
            None => {
                digests.insert(task_run_id, digest.to_string());
                Ok(())
            }
        }
    }

    fn set_pending_transition(
        &self,
        task_run_id: TaskRunId,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<(), TaskAccessError> {
        lock_map(&self.pending_by_run)?.insert(task_run_id, transition_id);
        Ok(())
    }

    fn clear_pending_transition(&self, task_run_id: TaskRunId) -> Result<(), TaskAccessError> {
        lock_map(&self.pending_by_run)?.remove(&task_run_id);
        Ok(())
    }

    fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError> {
        let mut runs = lock_map(&self.runs)?;
        Self::prune_expired(&mut runs, Utc::now());
        Ok(runs.values().cloned().collect())
    }
}

/// Thread-safe wrapper for sharing one store across concurrent task-access nodes.
pub struct SharedTaskStore<S: TaskStore> {
    inner: std::sync::Arc<std::sync::Mutex<S>>,
}

impl<S: TaskStore> Clone for SharedTaskStore<S> {
    fn clone(&self) -> Self {
        Self {
            inner: std::sync::Arc::clone(&self.inner),
        }
    }
}

impl<S: TaskStore> SharedTaskStore<S> {
    pub fn new(store: S) -> Self {
        Self {
            inner: std::sync::Arc::new(std::sync::Mutex::new(store)),
        }
    }

    pub fn from_arc(inner: std::sync::Arc<std::sync::Mutex<S>>) -> Self {
        Self { inner }
    }

    fn with_inner<R>(
        &self,
        f: impl FnOnce(&mut S) -> Result<R, TaskAccessError>,
    ) -> Result<R, TaskAccessError> {
        let mut guard = self.inner.lock().map_err(|_| lock_err())?;
        f(&mut *guard)
    }
}

impl<S: TaskStore> TaskStore for SharedTaskStore<S> {
    fn get_run(&self, id: TaskRunId) -> Result<Option<TaskRun>, TaskAccessError> {
        self.with_inner(|s| s.get_run(id))
    }

    fn save_run(&self, run: &TaskRun) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_run(run))
    }

    fn save_run_cas(
        &self,
        run: &TaskRun,
        expected_state_version: u64,
    ) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_run_cas(run, expected_state_version))
    }

    fn get_transition(
        &self,
        id: CapabilityStateTransitionId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        self.with_inner(|s| s.get_transition(id))
    }

    fn save_transition(
        &self,
        transition: &CapabilityStateTransition,
    ) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_transition(transition))
    }

    fn get_pending_transition(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        self.with_inner(|s| s.get_pending_transition(task_run_id))
    }

    fn get_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<AcknowledgementSet, TaskAccessError> {
        self.with_inner(|s| s.get_ack_set(transition_id))
    }

    fn save_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
        set: &AcknowledgementSet,
    ) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_ack_set(transition_id, set))
    }

    fn get_result_buffer(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<ProtectedResultBuffer>, TaskAccessError> {
        self.with_inner(|s| s.get_result_buffer(task_run_id))
    }

    fn save_result_buffer(&self, buffer: &ProtectedResultBuffer) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_result_buffer(buffer))
    }

    fn get_credential(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<TaskCredentialRecord>, TaskAccessError> {
        self.with_inner(|s| s.get_credential(task_run_id))
    }

    fn save_credential(&self, record: &TaskCredentialRecord) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_credential(record))
    }

    fn get_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<String>, TaskAccessError> {
        self.with_inner(|s| s.get_ceiling_digest(task_run_id))
    }

    fn save_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
        digest: &str,
    ) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.save_ceiling_digest(task_run_id, digest))
    }

    fn set_pending_transition(
        &self,
        task_run_id: TaskRunId,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.set_pending_transition(task_run_id, transition_id))
    }

    fn clear_pending_transition(&self, task_run_id: TaskRunId) -> Result<(), TaskAccessError> {
        self.with_inner(|s| s.clear_pending_transition(task_run_id))
    }

    fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError> {
        self.with_inner(|s| s.list_runs())
    }
}

pub struct StartTaskParams {
    pub template_id: TaskTemplateId,
    pub authority_context: AuthorityContext,
    pub ceiling: CeilingCompilation,
    pub maximum_expires_at: DateTime<Utc>,
    pub now: DateTime<Utc>,
}

pub struct ProposeRestrictionParams {
    pub task_run_id: TaskRunId,
    pub expected_state_version: u64,
    pub proposed_capabilities: CapabilitySet,
    pub required_mediation: Vec<MediationPointId>,
    pub result_payload: Option<serde_json::Value>,
    pub now: DateTime<Utc>,
}

pub struct RenewCredentialParams {
    pub task_run_id: TaskRunId,
    pub expected_state_version: u64,
    pub credential_digest: String,
    pub expires_at: DateTime<Utc>,
    pub now: DateTime<Utc>,
}

/// Trust Ratchet engine coordinating task-scoped capability lifecycle.
pub struct TaskAccessEngine<S: TaskStore> {
    store: S,
}

impl<S: TaskStore> TaskAccessEngine<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn compile_ceiling(
        &self,
        inputs: Vec<CeilingInput>,
        now: DateTime<Utc>,
    ) -> Result<CeilingCompilation, TaskAccessError> {
        Ok(CeilingCompilation::compile(inputs, now)?)
    }

    pub fn start_task(&self, params: StartTaskParams) -> Result<TaskRun, TaskAccessError> {
        params
            .authority_context
            .assert_single_effective_principal()?;
        let mut run = TaskRun {
            id: TaskRunId::new(),
            template_id: params.template_id,
            organization_id: params.authority_context.organization_id,
            project_id: params.authority_context.project_id,
            principal_id: params.authority_context.principal_ids[0],
            authority_context_id: params.authority_context.id,
            status: TaskRunStatus::Active,
            capability_ceiling: params.ceiling.compiled_ceiling.clone(),
            current_capabilities: params.ceiling.compiled_ceiling.clone(),
            state_version: 1,
            state_digest: String::new(),
            maximum_expires_at: params.maximum_expires_at,
            created_at: params.now,
            updated_at: params.now,
        };
        run.state_digest = run.compute_state_digest()?;
        self.store.save_run(&run)?;
        self.store
            .save_ceiling_digest(run.id, &params.ceiling.ceiling_digest)?;
        Ok(run)
    }

    /// Ceiling digest is immutable after task activation.
    pub fn assert_ceiling_unchanged(&self, run: &TaskRun) -> Result<(), TaskAccessError> {
        let stored = self
            .store
            .get_ceiling_digest(run.id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(run.id.to_string()))?;
        let current = run.capability_ceiling.digest()?;
        if stored != current {
            return Err(TaskAccessError::CeilingImmutable);
        }
        Ok(())
    }

    pub fn assert_capability(
        &self,
        task_run_id: TaskRunId,
        required: &Capability,
        expected_state_version: u64,
        now: DateTime<Utc>,
    ) -> Result<TaskRun, TaskAccessError> {
        let run = self
            .store
            .get_run(task_run_id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(task_run_id.to_string()))?;
        run.assert_active()?;
        // Status alone never expires: without this the ceiling would authorize
        // work indefinitely past `maximum_expires_at`.
        run.assert_not_expired(now)?;
        run.assert_state_version(expected_state_version)?;
        self.assert_ceiling_unchanged(&run)?;
        let held = CapabilitySet::new(vec![required.clone()]);
        if !held.is_subset_of(&run.current_capabilities) {
            return Err(TaskAccessError::Domain(DomainError::AuthorizationDenied(
                "capability not held".into(),
            )));
        }
        Ok(run)
    }

    pub fn propose_restriction(
        &self,
        params: ProposeRestrictionParams,
    ) -> Result<CapabilityStateTransition, TaskAccessError> {
        let mut run = self
            .store
            .get_run(params.task_run_id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(params.task_run_id.to_string()))?;
        run.assert_active()?;
        run.assert_state_version(params.expected_state_version)?;
        self.assert_ceiling_unchanged(&run)?;
        run.validate_restriction(&params.proposed_capabilities)?;

        let removed = diff_removed(&run.current_capabilities, &params.proposed_capabilities);
        let transition = CapabilityStateTransition {
            id: CapabilityStateTransitionId::new(),
            task_run_id: run.id,
            from_state_version: run.state_version,
            to_state_version: run.state_version + 1,
            status: CapabilityTransitionStatus::AwaitingAcknowledgements,
            removed,
            resulting_capabilities: params.proposed_capabilities.clone(),
            trigger_evidence_digest: None,
            created_at: params.now,
            committed_at: None,
        };

        if let Some(payload) = params.result_payload {
            let digest = opensesame_domain::digest_json(&payload)?;
            let buffer = ProtectedResultBuffer {
                task_run_id: run.id,
                transition_id: transition.id.to_string(),
                state_version: transition.to_state_version,
                result_digest: digest,
                payload,
                created_at: params.now,
                released: false,
            };
            self.store.save_result_buffer(&buffer)?;
        }

        let ack_set = AcknowledgementSet {
            required: params.required_mediation,
            received: vec![],
        };
        self.store.save_ack_set(transition.id, &ack_set)?;
        self.store.save_transition(&transition)?;
        self.store.set_pending_transition(run.id, transition.id)?;

        run.status = TaskRunStatus::Restricting;
        run.updated_at = params.now;
        // CAS so a concurrent commit/terminate is not silently overwritten with
        // this stale copy (which would restore the wider capability set).
        self.store
            .save_run_cas(&run, params.expected_state_version)?;

        Ok(transition)
    }

    pub fn acknowledge(
        &self,
        transition_id: CapabilityStateTransitionId,
        ack: EnforcementAcknowledgement,
    ) -> Result<AcknowledgementSet, TaskAccessError> {
        let transition = self
            .store
            .get_transition(transition_id)?
            .ok_or_else(|| TaskAccessError::TransitionNotFound(transition_id.to_string()))?;
        ack.assert_matches_transition(transition.task_run_id, transition.to_state_version)?;
        let mut set = self.store.get_ack_set(transition_id)?;
        set.accept(&ack)?;
        self.store.save_ack_set(transition_id, &set)?;
        Ok(set)
    }

    pub fn commit_transition(
        &self,
        task_run_id: TaskRunId,
        transition_id: CapabilityStateTransitionId,
        now: DateTime<Utc>,
    ) -> Result<TaskRun, TaskAccessError> {
        let transition = self
            .store
            .get_transition(transition_id)?
            .ok_or_else(|| TaskAccessError::TransitionNotFound(transition_id.to_string()))?;
        if transition.task_run_id != task_run_id {
            return Err(TaskAccessError::TransitionNotFound(
                transition_id.to_string(),
            ));
        }

        let ack_set = self.store.get_ack_set(transition_id)?;
        ack_set.assert_complete()?;

        let mut run = self
            .store
            .get_run(task_run_id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(task_run_id.to_string()))?;
        run.assert_state_version(transition.from_state_version)?;
        self.assert_ceiling_unchanged(&run)?;

        run.current_capabilities = transition.resulting_capabilities.clone();
        run.state_version = transition.to_state_version;
        run.state_digest = run.compute_state_digest()?;
        run.status = TaskRunStatus::Active;
        run.updated_at = now;

        let mut committed = transition.clone();
        committed.status = CapabilityTransitionStatus::Committed;
        committed.committed_at = Some(now);
        self.store.save_transition(&committed)?;
        self.store
            .save_run_cas(&run, transition.from_state_version)?;

        // Release only the buffer this transition fenced. A buffer left behind by
        // a superseded proposal has not had its own acknowledgements, and
        // releasing it here would let a result escape the fence that held it.
        if let Some(mut buffer) = self.store.get_result_buffer(task_run_id)? {
            if buffer.transition_id == transition.id.to_string()
                && buffer.state_version == transition.to_state_version
            {
                buffer.released = true;
                self.store.save_result_buffer(&buffer)?;
            }
        }

        self.store.clear_pending_transition(task_run_id)?;

        Ok(run)
    }

    pub fn release_result_buffer(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<ProtectedResultBuffer, TaskAccessError> {
        let buffer = self
            .store
            .get_result_buffer(task_run_id)?
            .ok_or(TaskAccessError::ResultBufferHeld)?;
        if !buffer.released {
            return Err(TaskAccessError::ResultBufferHeld);
        }
        Ok(buffer)
    }

    pub fn renew_credential(
        &self,
        params: RenewCredentialParams,
    ) -> Result<TaskCredentialRecord, TaskAccessError> {
        let run = self
            .store
            .get_run(params.task_run_id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(params.task_run_id.to_string()))?;
        run.assert_active()?;
        run.assert_not_expired(params.now)?;
        run.assert_state_version(params.expected_state_version)?;
        self.assert_ceiling_unchanged(&run)?;

        if params.expires_at > run.maximum_expires_at {
            return Err(TaskAccessError::CredentialRenewalExceeded);
        }

        let record = TaskCredentialRecord {
            id: opensesame_domain::TaskCredentialId::new(),
            task_run_id: run.id,
            credential_digest: params.credential_digest,
            state_version: run.state_version,
            issued_at: params.now,
            expires_at: params.expires_at,
        };
        self.store.save_credential(&record)?;
        Ok(record)
    }

    pub fn assert_authority_context_unchanged(
        &self,
        run: &TaskRun,
        proposed: &AuthorityContext,
    ) -> Result<(), TaskAccessError> {
        if run.authority_context_id != proposed.id {
            return Err(TaskAccessError::Domain(DomainError::AuthorityContextLocked));
        }
        Ok(())
    }

    /// Terminate a task — marks Cancelled and bumps state version. Further assert_capability calls fail.
    pub fn terminate_task(
        &self,
        task_run_id: TaskRunId,
        expected_state_version: u64,
        now: DateTime<Utc>,
    ) -> Result<TaskRun, TaskAccessError> {
        let mut run = self
            .store
            .get_run(task_run_id)?
            .ok_or_else(|| TaskAccessError::TaskNotFound(task_run_id.to_string()))?;
        if run.status == TaskRunStatus::Cancelled || run.status == TaskRunStatus::Completed {
            return Err(TaskAccessError::Domain(DomainError::TaskNotActive));
        }
        run.assert_state_version(expected_state_version)?;
        run.status = TaskRunStatus::Cancelled;
        run.state_version += 1;
        run.state_digest = run.compute_state_digest()?;
        run.updated_at = now;
        self.store.save_run_cas(&run, expected_state_version)?;
        Ok(run)
    }

    pub fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError> {
        self.store.list_runs()
    }
}

fn diff_removed(before: &CapabilitySet, after: &CapabilitySet) -> CapabilitySet {
    let mut removed = Vec::new();
    let after_c = after.canonicalize();
    for cap in before.canonicalize().capabilities {
        let single = CapabilitySet::new(vec![cap.clone()]);
        if !single.is_subset_of(&after_c) {
            removed.push(cap);
        }
    }
    CapabilitySet::new(removed).canonicalize()
}
