//! SQLite-backed TaskStore for durable local authority (not multi-node HA).
//!
//! Proves CAS fencing and persistence without external Postgres. Production
//! multi-node deployments must use [`crate::PostgresTaskStore`] (ADR 0031).

use crate::credential::{ProtectedResultBuffer, TaskCredentialRecord};
use crate::engine::TaskStore;
use crate::postgres::TaskAuthorityBackend;
use crate::TaskAccessError;
use chrono::{DateTime, Utc};
use opensesame_domain::{
    AcknowledgementSet, CapabilitySet, CapabilityStateTransition, CapabilityStateTransitionId,
    CapabilityTransitionStatus, DomainError, TaskRun, TaskRunId, TaskRunStatus,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::runtime::Runtime;

const MIGRATION: &str = include_str!("../migrations/0001_task_access_sqlite.sql");

pub struct SqliteTaskStore {
    pool: SqlitePool,
    migrated: AtomicBool,
}

impl SqliteTaskStore {
    /// Sync connect — owns no nested runtime; uses a short-lived runtime for setup only.
    pub fn connect(database_url: &str) -> Result<Self, TaskAccessError> {
        let rt = Runtime::new().map_err(|e| TaskAccessError::Storage(e.to_string()))?;
        rt.block_on(async {
            let options = SqliteConnectOptions::from_str(database_url)
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(5)
                .connect_with(options)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            let store = Self {
                pool,
                migrated: AtomicBool::new(false),
            };
            store.migrate_async().await?;
            Ok(store)
        })
    }

    pub fn connect_memory() -> Result<Self, TaskAccessError> {
        Self::connect("sqlite::memory:")
    }

    async fn migrate_async(&self) -> Result<(), TaskAccessError> {
        for stmt in MIGRATION.split(';') {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            sqlx::query(stmt)
                .execute(&self.pool)
                .await
                .map_err(|e| TaskAccessError::Storage(format!("migrate: {e}")))?;
        }
        self.migrated.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn migrate(&self) -> Result<(), TaskAccessError> {
        self.block_on(self.migrate_async())
    }

    pub fn authority_backend(&self) -> TaskAuthorityBackend {
        TaskAuthorityBackend::SqliteLocal
    }

    pub fn is_migrated(&self) -> bool {
        self.migrated.load(Ordering::SeqCst)
    }

    fn block_on<F: std::future::Future<Output = T>, T>(&self, fut: F) -> T {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
            Err(_) => Runtime::new()
                .expect("sqlite task store runtime")
                .block_on(fut),
        }
    }
}

fn status_to_str(status: TaskRunStatus) -> &'static str {
    match status {
        TaskRunStatus::Pending => "pending",
        TaskRunStatus::Active => "active",
        TaskRunStatus::Restricting => "restricting",
        TaskRunStatus::Completed => "completed",
        TaskRunStatus::Failed => "failed",
        TaskRunStatus::Cancelled => "cancelled",
    }
}

fn status_from_str(s: &str) -> Result<TaskRunStatus, TaskAccessError> {
    match s {
        "pending" => Ok(TaskRunStatus::Pending),
        "active" => Ok(TaskRunStatus::Active),
        "restricting" => Ok(TaskRunStatus::Restricting),
        "completed" => Ok(TaskRunStatus::Completed),
        "failed" => Ok(TaskRunStatus::Failed),
        "cancelled" => Ok(TaskRunStatus::Cancelled),
        other => Err(TaskAccessError::Storage(format!(
            "unknown task status: {other}"
        ))),
    }
}

fn transition_status_to_str(status: CapabilityTransitionStatus) -> &'static str {
    match status {
        CapabilityTransitionStatus::Proposed => "proposed",
        CapabilityTransitionStatus::Fencing => "fencing",
        CapabilityTransitionStatus::AwaitingAcknowledgements => "awaiting_acknowledgements",
        CapabilityTransitionStatus::Committed => "committed",
        CapabilityTransitionStatus::Rejected => "rejected",
    }
}

fn transition_status_from_str(s: &str) -> Result<CapabilityTransitionStatus, TaskAccessError> {
    match s {
        "proposed" => Ok(CapabilityTransitionStatus::Proposed),
        "fencing" => Ok(CapabilityTransitionStatus::Fencing),
        "awaiting_acknowledgements" => Ok(CapabilityTransitionStatus::AwaitingAcknowledgements),
        "committed" => Ok(CapabilityTransitionStatus::Committed),
        "rejected" => Ok(CapabilityTransitionStatus::Rejected),
        other => Err(TaskAccessError::Storage(format!(
            "unknown transition status: {other}"
        ))),
    }
}

fn parse_dt(s: &str) -> Result<DateTime<Utc>, TaskAccessError> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|e| TaskAccessError::Storage(e.to_string()))
}

fn row_to_run(row: &SqliteRow) -> Result<TaskRun, TaskAccessError> {
    let ceiling: CapabilitySet = serde_json::from_str(&row.get::<String, _>("capability_ceiling"))
        .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
    let current: CapabilitySet =
        serde_json::from_str(&row.get::<String, _>("current_capabilities"))
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
    Ok(TaskRun {
        id: TaskRunId::parse(&row.get::<String, _>("id"))?,
        template_id: opensesame_domain::TaskTemplateId::parse(
            &row.get::<String, _>("template_id"),
        )?,
        organization_id: opensesame_domain::OrganizationId::parse(
            &row.get::<String, _>("organization_id"),
        )?,
        project_id: row
            .get::<Option<String>, _>("project_id")
            .map(|s| opensesame_domain::ProjectId::parse(&s))
            .transpose()?,
        principal_id: opensesame_domain::PrincipalId::parse(&row.get::<String, _>("principal_id"))?,
        authority_context_id: opensesame_domain::AuthorityContextId::parse(
            &row.get::<String, _>("authority_context_id"),
        )?,
        status: status_from_str(row.get::<String, _>("status").as_str())?,
        capability_ceiling: ceiling,
        current_capabilities: current,
        state_version: row.get::<i64, _>("state_version") as u64,
        state_digest: row.get("state_digest"),
        maximum_expires_at: parse_dt(&row.get::<String, _>("maximum_expires_at"))?,
        created_at: parse_dt(&row.get::<String, _>("created_at"))?,
        updated_at: parse_dt(&row.get::<String, _>("updated_at"))?,
    })
}

impl TaskStore for SqliteTaskStore {
    fn get_run(&self, id: TaskRunId) -> Result<Option<TaskRun>, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = id.to_string();
        self.block_on(async move {
            let row = sqlx::query(
                r#"
                SELECT id, template_id, organization_id, project_id, principal_id,
                       authority_context_id, status, capability_ceiling, current_capabilities,
                       state_version, state_digest, maximum_expires_at, created_at, updated_at
                FROM task_runs WHERE id = ?
                "#,
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.as_ref().map(row_to_run).transpose()
        })
    }

    fn save_run(&self, run: &TaskRun) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let run = run.clone();
        self.block_on(async move {
            let existing = sqlx::query(
                "SELECT ceiling_digest, pending_transition_id FROM task_runs WHERE id = ?",
            )
            .bind(run.id.to_string())
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            let (ceiling_digest, pending) = match existing {
                Some(row) => (
                    row.get::<String, _>("ceiling_digest"),
                    row.get::<Option<String>, _>("pending_transition_id"),
                ),
                None => (run.capability_ceiling.digest()?, None),
            };
            let ceiling_json = serde_json::to_string(&run.capability_ceiling)
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            let current_json = serde_json::to_string(&run.current_capabilities)
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            sqlx::query(
                r#"
                INSERT INTO task_runs (
                    id, template_id, organization_id, project_id, principal_id,
                    authority_context_id, status, capability_ceiling, current_capabilities,
                    state_version, state_digest, ceiling_digest, maximum_expires_at,
                    pending_transition_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    current_capabilities = excluded.current_capabilities,
                    state_version = excluded.state_version,
                    state_digest = excluded.state_digest,
                    maximum_expires_at = excluded.maximum_expires_at,
                    pending_transition_id = excluded.pending_transition_id,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(run.id.to_string())
            .bind(run.template_id.to_string())
            .bind(run.organization_id.to_string())
            .bind(run.project_id.map(|p| p.to_string()))
            .bind(run.principal_id.to_string())
            .bind(run.authority_context_id.to_string())
            .bind(status_to_str(run.status))
            .bind(ceiling_json)
            .bind(current_json)
            .bind(run.state_version as i64)
            .bind(&run.state_digest)
            .bind(ceiling_digest)
            .bind(run.maximum_expires_at.to_rfc3339())
            .bind(pending)
            .bind(run.created_at.to_rfc3339())
            .bind(run.updated_at.to_rfc3339())
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn save_run_cas(
        &self,
        run: &TaskRun,
        expected_state_version: u64,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let run = run.clone();
        self.block_on(async move {
            let current_json = serde_json::to_string(&run.current_capabilities)
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            let result = sqlx::query(
                r#"
                UPDATE task_runs SET
                    status = ?,
                    current_capabilities = ?,
                    state_version = ?,
                    state_digest = ?,
                    updated_at = ?
                WHERE id = ? AND state_version = ?
                "#,
            )
            .bind(status_to_str(run.status))
            .bind(current_json)
            .bind(run.state_version as i64)
            .bind(&run.state_digest)
            .bind(run.updated_at.to_rfc3339())
            .bind(run.id.to_string())
            .bind(expected_state_version as i64)
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            if result.rows_affected() == 0 {
                return Err(TaskAccessError::Domain(
                    DomainError::TaskStateVersionMismatch {
                        expected: expected_state_version,
                        actual: expected_state_version.saturating_add(1),
                    },
                ));
            }
            Ok(())
        })
    }

    fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError> {
        let pool = self.pool.clone();
        self.block_on(async move {
            let rows = sqlx::query(
                r#"
                SELECT id, template_id, organization_id, project_id, principal_id,
                       authority_context_id, status, capability_ceiling, current_capabilities,
                       state_version, state_digest, maximum_expires_at, created_at, updated_at
                FROM task_runs ORDER BY created_at DESC
                "#,
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            rows.iter().map(row_to_run).collect()
        })
    }

    fn get_transition(
        &self,
        id: CapabilityStateTransitionId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = id.to_string();
        self.block_on(async move {
            let row = sqlx::query(
                r#"
                SELECT id, task_run_id, from_state_version, to_state_version, status,
                       removed, resulting_capabilities, trigger_evidence_digest,
                       created_at, committed_at
                FROM capability_transitions WHERE id = ?
                "#,
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.map(|row| {
                Ok(CapabilityStateTransition {
                    id: CapabilityStateTransitionId::parse(&row.get::<String, _>("id"))?,
                    task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                    from_state_version: row.get::<i64, _>("from_state_version") as u64,
                    to_state_version: row.get::<i64, _>("to_state_version") as u64,
                    status: transition_status_from_str(row.get::<String, _>("status").as_str())?,
                    removed: serde_json::from_str(&row.get::<String, _>("removed"))
                        .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                    resulting_capabilities: serde_json::from_str(
                        &row.get::<String, _>("resulting_capabilities"),
                    )
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                    trigger_evidence_digest: row.get("trigger_evidence_digest"),
                    created_at: parse_dt(&row.get::<String, _>("created_at"))?,
                    committed_at: row
                        .get::<Option<String>, _>("committed_at")
                        .map(|s| parse_dt(&s))
                        .transpose()?,
                })
            })
            .transpose()
        })
    }

    fn save_transition(
        &self,
        transition: &CapabilityStateTransition,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let t = transition.clone();
        self.block_on(async move {
            sqlx::query(
                r#"
                INSERT INTO capability_transitions (
                    id, task_run_id, from_state_version, to_state_version, status,
                    removed, resulting_capabilities, trigger_evidence_digest,
                    created_at, committed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    committed_at = excluded.committed_at
                "#,
            )
            .bind(t.id.to_string())
            .bind(t.task_run_id.to_string())
            .bind(t.from_state_version as i64)
            .bind(t.to_state_version as i64)
            .bind(transition_status_to_str(t.status))
            .bind(
                serde_json::to_string(&t.removed)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(
                serde_json::to_string(&t.resulting_capabilities)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(t.trigger_evidence_digest)
            .bind(t.created_at.to_rfc3339())
            .bind(t.committed_at.map(|d| d.to_rfc3339()))
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn get_pending_transition(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        let pool = self.pool.clone();
        let id = task_run_id.to_string();
        self.block_on(async move {
            let tid: Option<String> =
                sqlx::query("SELECT pending_transition_id FROM task_runs WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?
                    .and_then(|r| r.get("pending_transition_id"));
            match tid {
                Some(tid) => {
                    let tid = CapabilityStateTransitionId::parse(&tid)?;
                    // re-enter via pool query
                    let row = sqlx::query(
                        r#"
                        SELECT id, task_run_id, from_state_version, to_state_version, status,
                               removed, resulting_capabilities, trigger_evidence_digest,
                               created_at, committed_at
                        FROM capability_transitions WHERE id = ?
                        "#,
                    )
                    .bind(tid.to_string())
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
                    row.map(|row| {
                        Ok(CapabilityStateTransition {
                            id: CapabilityStateTransitionId::parse(&row.get::<String, _>("id"))?,
                            task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                            from_state_version: row.get::<i64, _>("from_state_version") as u64,
                            to_state_version: row.get::<i64, _>("to_state_version") as u64,
                            status: transition_status_from_str(
                                row.get::<String, _>("status").as_str(),
                            )?,
                            removed: serde_json::from_str(&row.get::<String, _>("removed"))
                                .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                            resulting_capabilities: serde_json::from_str(
                                &row.get::<String, _>("resulting_capabilities"),
                            )
                            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                            trigger_evidence_digest: row.get("trigger_evidence_digest"),
                            created_at: parse_dt(&row.get::<String, _>("created_at"))?,
                            committed_at: row
                                .get::<Option<String>, _>("committed_at")
                                .map(|s| parse_dt(&s))
                                .transpose()?,
                        })
                    })
                    .transpose()
                }
                None => Ok(None),
            }
        })
    }

    fn get_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<AcknowledgementSet, TaskAccessError> {
        let pool = self.pool.clone();
        let id = transition_id.to_string();
        self.block_on(async move {
            let row =
                sqlx::query("SELECT required, received FROM ack_sets WHERE transition_id = ?")
                    .bind(&id)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            match row {
                Some(row) => Ok(AcknowledgementSet {
                    required: serde_json::from_str(&row.get::<String, _>("required"))
                        .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                    received: serde_json::from_str(&row.get::<String, _>("received"))
                        .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                }),
                None => Ok(AcknowledgementSet {
                    required: vec![],
                    received: vec![],
                }),
            }
        })
    }

    fn save_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
        set: &AcknowledgementSet,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let id = transition_id.to_string();
        let set = set.clone();
        self.block_on(async move {
            sqlx::query(
                r#"
                INSERT INTO ack_sets (transition_id, required, received)
                VALUES (?, ?, ?)
                ON CONFLICT(transition_id) DO UPDATE SET
                    required = excluded.required,
                    received = excluded.received
                "#,
            )
            .bind(id)
            .bind(
                serde_json::to_string(&set.required)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(
                serde_json::to_string(&set.received)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn get_result_buffer(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<ProtectedResultBuffer>, TaskAccessError> {
        let pool = self.pool.clone();
        let id = task_run_id.to_string();
        self.block_on(async move {
            let row = sqlx::query(
                r#"
                SELECT task_run_id, transition_id, state_version, result_digest,
                       payload, released, created_at
                FROM result_buffers WHERE task_run_id = ?
                "#,
            )
            .bind(&id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.map(|row| {
                Ok(ProtectedResultBuffer {
                    task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                    transition_id: row.get("transition_id"),
                    state_version: row.get::<i64, _>("state_version") as u64,
                    result_digest: row.get("result_digest"),
                    payload: serde_json::from_str(&row.get::<String, _>("payload"))
                        .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                    created_at: parse_dt(&row.get::<String, _>("created_at"))?,
                    released: row.get::<i64, _>("released") != 0,
                })
            })
            .transpose()
        })
    }

    fn save_result_buffer(&self, buffer: &ProtectedResultBuffer) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let b = buffer.clone();
        self.block_on(async move {
            sqlx::query(
                r#"
                INSERT INTO result_buffers (
                    task_run_id, transition_id, state_version, result_digest,
                    payload, released, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_run_id) DO UPDATE SET
                    transition_id = excluded.transition_id,
                    state_version = excluded.state_version,
                    result_digest = excluded.result_digest,
                    payload = excluded.payload,
                    released = excluded.released
                "#,
            )
            .bind(b.task_run_id.to_string())
            .bind(&b.transition_id)
            .bind(b.state_version as i64)
            .bind(&b.result_digest)
            .bind(
                serde_json::to_string(&b.payload)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(if b.released { 1 } else { 0 })
            .bind(b.created_at.to_rfc3339())
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn get_credential(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<TaskCredentialRecord>, TaskAccessError> {
        let pool = self.pool.clone();
        let id = task_run_id.to_string();
        self.block_on(async move {
            let row = sqlx::query(
                r#"
                SELECT id, task_run_id, credential_digest, state_version, issued_at, expires_at
                FROM task_credentials WHERE task_run_id = ?
                ORDER BY issued_at DESC LIMIT 1
                "#,
            )
            .bind(&id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.map(|row| {
                Ok(TaskCredentialRecord {
                    id: opensesame_domain::TaskCredentialId::parse(&row.get::<String, _>("id"))?,
                    task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                    credential_digest: row.get("credential_digest"),
                    state_version: row.get::<i64, _>("state_version") as u64,
                    issued_at: parse_dt(&row.get::<String, _>("issued_at"))?,
                    expires_at: parse_dt(&row.get::<String, _>("expires_at"))?,
                })
            })
            .transpose()
        })
    }

    fn save_credential(&self, record: &TaskCredentialRecord) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let r = record.clone();
        self.block_on(async move {
            sqlx::query(
                r#"
                INSERT INTO task_credentials (
                    id, task_run_id, credential_digest, state_version, issued_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    credential_digest = excluded.credential_digest,
                    state_version = excluded.state_version,
                    expires_at = excluded.expires_at
                "#,
            )
            .bind(r.id.to_string())
            .bind(r.task_run_id.to_string())
            .bind(&r.credential_digest)
            .bind(r.state_version as i64)
            .bind(r.issued_at.to_rfc3339())
            .bind(r.expires_at.to_rfc3339())
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn get_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<String>, TaskAccessError> {
        let pool = self.pool.clone();
        let id = task_run_id.to_string();
        self.block_on(async move {
            let row = sqlx::query("SELECT ceiling_digest FROM task_runs WHERE id = ?")
                .bind(&id)
                .fetch_optional(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(row.map(|r| r.get("ceiling_digest")))
        })
    }

    /// Write-once: a ceiling digest may be set, and may be set again to the same
    /// value, but never changed. Immutability that only holds on the read path is
    /// one stray writer away from not holding at all.
    fn save_ceiling_digest(
        &self,
        task_run_id: TaskRunId,
        digest: &str,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let id = task_run_id.to_string();
        let digest = digest.to_string();
        self.block_on(async move {
            let updated = sqlx::query(
                "UPDATE task_runs SET ceiling_digest = ?1 \
                 WHERE id = ?2 AND (ceiling_digest = '' OR ceiling_digest = ?1)",
            )
            .bind(&digest)
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            if updated.rows_affected() == 0 {
                // No row yet is the ordinary start path: `save_run` derives the
                // digest when it inserts. A row with a *different* digest is not.
                let existing = sqlx::query("SELECT ceiling_digest FROM task_runs WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
                if existing.is_some() {
                    return Err(TaskAccessError::CeilingImmutable);
                }
            }
            Ok(())
        })
    }

    fn set_pending_transition(
        &self,
        task_run_id: TaskRunId,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let run_id = task_run_id.to_string();
        let tid = transition_id.to_string();
        self.block_on(async move {
            sqlx::query("UPDATE task_runs SET pending_transition_id = ? WHERE id = ?")
                .bind(tid)
                .bind(run_id)
                .execute(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn clear_pending_transition(&self, task_run_id: TaskRunId) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let run_id = task_run_id.to_string();
        self.block_on(async move {
            sqlx::query("UPDATE task_runs SET pending_transition_id = NULL WHERE id = ?")
                .bind(run_id)
                .execute(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{assert_store_object_safe, distributed_task_authority_ok};
    use crate::{StartTaskParams, TaskAccessEngine};
    use chrono::{Duration, Utc};
    use opensesame_domain::{
        AuthorityContext, AuthorityContextId, AuthorityContextMode, Capability, CapabilitySet,
        CeilingInput, OrganizationId, PrincipalId, ResourceSelector, TaskTemplateId,
    };
    use tempfile::TempDir;

    #[test]
    fn sqlite_store_round_trip_cas_and_fence() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("tasks.db");
        let url = format!("sqlite:{}", path.display());
        let store = SqliteTaskStore::connect(&url).unwrap();
        assert!(!distributed_task_authority_ok(store.authority_backend()));
        assert_store_object_safe::<SqliteTaskStore>();

        let engine = TaskAccessEngine::new(store);
        let now = Utc::now();
        let principal = PrincipalId::new();
        let caps = CapabilitySet::new(vec![
            Capability::new("read", ResourceSelector::exact("repo:a")),
            Capability::new("send", ResourceSelector::exact("ext:1")),
        ]);
        let ctx = AuthorityContext {
            id: AuthorityContextId::new(),
            mode: AuthorityContextMode::SinglePrincipal,
            organization_id: OrganizationId::new(),
            project_id: None,
            principal_ids: vec![principal],
            capability_ceiling: caps.clone(),
            compiled_at: now,
        };
        let ceiling = engine
            .compile_ceiling(
                vec![CeilingInput {
                    principal_id: principal,
                    capabilities: caps,
                }],
                now,
            )
            .unwrap();
        let run = engine
            .start_task(StartTaskParams {
                template_id: TaskTemplateId::new(),
                authority_context: ctx,
                ceiling,
                maximum_expires_at: now + Duration::hours(2),
                now,
            })
            .unwrap();

        let loaded = engine.store().get_run(run.id).unwrap().unwrap();
        assert_eq!(loaded.state_version, 1);

        // Advance via non-CAS write, then stale CAS expected=1 must fail.
        let mut bumped = loaded.clone();
        bumped.state_version = 2;
        bumped.updated_at = Utc::now();
        engine.store().save_run(&bumped).unwrap();
        bumped.state_version = 3;
        let err = engine.store().save_run_cas(&bumped, 1).unwrap_err();
        assert!(matches!(
            err,
            TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
        ));

        // Second connection on same file — stale expected version rejected.
        let store2 = SqliteTaskStore::connect(&url).unwrap();
        let mut ghost = store2.get_run(run.id).unwrap().unwrap();
        ghost.state_version = 9;
        let err = store2.save_run_cas(&ghost, 1).unwrap_err();
        assert!(matches!(
            err,
            TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
        ));
        assert_eq!(store2.list_runs().unwrap().len(), 1);

        // A ceiling digest is write-once. Re-recording the same value is fine;
        // a different one is refused by the store, not merely noticed on read.
        let recorded = engine
            .store()
            .get_ceiling_digest(run.id)
            .unwrap()
            .expect("digest recorded at start");
        engine
            .store()
            .save_ceiling_digest(run.id, &recorded)
            .unwrap();
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

        // And a non-CAS re-save cannot widen the stored ceiling either.
        let mut widened = engine.store().get_run(run.id).unwrap().unwrap();
        widened.capability_ceiling = CapabilitySet::new(vec![Capability::new(
            "admin",
            ResourceSelector::exact("repo:*"),
        )]);
        engine.store().save_run(&widened).unwrap();
        let reloaded = engine.store().get_run(run.id).unwrap().unwrap();
        assert_eq!(
            reloaded.capability_ceiling, loaded.capability_ceiling,
            "the stored ceiling is the one compiled at start"
        );
    }
}
