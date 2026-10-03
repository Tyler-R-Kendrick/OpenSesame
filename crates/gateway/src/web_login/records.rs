//! A hosted run's interception records, on their way to the audit table.
//!
//! The hook session delivers each record synchronously, under its own lock,
//! in `sequence` order; storage is async. So the sink only projects and
//! buffers, and the step channel flushes the buffer **before** it hands the
//! next step to the driver. Every record that precedes a step — its
//! `pre_tool_call` above all — is durable before the step can act, and a
//! record that cannot be written stops the run rather than letting it act
//! unrecorded. The launcher flushes whatever the last step left behind.
//!
//! The projection is narrower than the SDK record (§10.3): no message, no
//! transform value, and a reason only when it is a short machine identifier.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use chrono::Utc;
use opensesame_agent_hooks::sdk::InterceptionRecord;
use opensesame_rotation_web::hooks::RecordSink;
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::Db;

/// Where a run is recorded, and under which policy version.
#[derive(Clone, Debug)]
pub(crate) struct RecordScope {
    pub organization_id: String,
    pub run_id: String,
    pub policy_version: i64,
}

/// The value-blind row for one interception.
pub(crate) fn project(scope: &RecordScope, record: &InterceptionRecord) -> StoredAgentHookRecord {
    StoredAgentHookRecord {
        run_id: scope.run_id.clone(),
        organization_id: scope.organization_id.clone(),
        sequence: record.sequence,
        interception_point: record.interception_point.as_str().to_owned(),
        decision: record.verdict.decision.as_str().to_owned(),
        escalated: record.verdict.approval.is_some(),
        reason: crate::agent_hooks::audit_reason(&record.verdict).map(str::to_owned),
        decided_by: record.decided_by.map(i64::from),
        input_identity: record.input_identity.clone(),
        enforced_identity: record.enforced_identity.clone(),
        policy_version: scope.policy_version,
        recorded_at: record
            .timestamp
            .clone()
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
    }
}

/// Records made but not yet written, and whether a write ever failed.
#[derive(Default)]
pub(crate) struct RecordBuffer {
    pending: Mutex<Vec<StoredAgentHookRecord>>,
    failed: AtomicBool,
}

impl RecordBuffer {
    /// The session's sink: project and queue, nothing else.
    pub(crate) fn sink(self: &Arc<Self>, scope: RecordScope) -> RecordSink {
        let buffer = Arc::clone(self);
        Arc::new(move |record: &InterceptionRecord| {
            buffer
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(project(&scope, record));
        })
    }

    /// Write everything queued, in order.
    ///
    /// # Errors
    ///
    /// The write failed now or earlier. Once one has, every later flush
    /// fails too: a run with a hole in its record does not get to act again.
    pub(crate) async fn flush(&self, db: &Db) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.failed.load(Ordering::SeqCst),
            "an earlier hook record could not be written"
        );
        let batch =
            std::mem::take(&mut *self.pending.lock().unwrap_or_else(PoisonError::into_inner));
        if batch.is_empty() {
            return Ok(());
        }
        if let Err(error) = db.append_agent_hook_records(&batch).await {
            self.failed.store(true, Ordering::SeqCst);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_agent_hooks::sdk::{
        CompositionConfig, EnforcementMode, InterceptionPoint, Verdict,
    };

    fn record(verdict: Verdict) -> InterceptionRecord {
        InterceptionRecord {
            interception_point: InterceptionPoint::PreToolCall,
            mode: EnforcementMode::Enforce,
            verdict,
            input_identity: Some("sha256:aa".into()),
            enforced_identity: Some("sha256:aa".into()),
            identity_provider: Some("jcs-sha256".into()),
            session_id: "run_1".into(),
            sequence: 4,
            timestamp: None,
            trace: None,
            decided_by: Some(0),
            composition: CompositionConfig::default(),
            verdicts: Vec::new(),
            fold_truncated: None,
            resolved_by: None,
            interceptors_registered: 1,
        }
    }

    #[test]
    fn a_projection_keeps_no_message_and_no_prose_reason() {
        let scope = RecordScope {
            organization_id: "org".into(),
            run_id: "run_1".into(),
            policy_version: 3,
        };
        let secret = format!("ghp_{}", "x".repeat(36));
        let row = project(
            &scope,
            &record(Verdict::deny(
                Some(format!("because {secret}")),
                Some(format!("message {secret}")),
            )),
        );
        assert_eq!(
            row.interception_point,
            InterceptionPoint::PreToolCall.as_str()
        );
        assert_eq!(row.decision, "deny");
        assert_eq!(row.reason.as_deref(), Some("opensesame:reason_withheld"));
        assert_eq!(row.sequence, 4);
        assert_eq!(row.policy_version, 3);
        assert!(!format!("{row:?}").contains(&secret));

        let named = project(
            &scope,
            &record(Verdict::deny(Some("opensesame:tool_denied".into()), None)),
        );
        assert_eq!(named.reason.as_deref(), Some("opensesame:tool_denied"));
    }

    #[tokio::test]
    async fn a_failed_write_poisons_every_later_flush() {
        let db = Db::connect_memory().await.unwrap();
        // The records belong to a run, and the store holds them to that.
        let now = chrono::Utc::now().to_rfc3339();
        db.create_observation_run(&opensesame_storage::StoredObservationRun {
            id: "run_1".into(),
            organization_id: "org".into(),
            job_id: "job_1".into(),
            target_origin: "https://login.example".into(),
            tier: "t3".into(),
            control_state: "agent_driving".into(),
            quiescence: "quiescent".into(),
            handoff_queued: false,
            lease_holder: None,
            lease_expires_at: None,
            owner_principal_id: "principal:owner".into(),
            viewer_key_id: "none:hook-records-only".into(),
            next_seq: 0,
            blocked_reason: None,
            expires_at: "2999-01-01T00:00:00+00:00".into(),
            closed_at: None,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        })
        .await
        .unwrap();
        let buffer = Arc::new(RecordBuffer::default());
        let scope = RecordScope {
            organization_id: "org".into(),
            run_id: "run_1".into(),
            policy_version: 0,
        };
        let sink = buffer.sink(scope);
        let one = record(Verdict::allow());
        sink(&one);
        buffer.flush(&db).await.unwrap();
        // The same sequence again is a constraint failure, never an overwrite.
        sink(&one);
        assert!(buffer.flush(&db).await.is_err());
        assert!(buffer.flush(&db).await.is_err(), "the run stays stopped");
        assert_eq!(
            db.agent_hook_records("org", "run_1").await.unwrap().len(),
            1
        );
    }
}
