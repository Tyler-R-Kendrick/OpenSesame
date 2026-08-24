//! PostgreSQL-backed task store for distributed Host API deployments (ADR 0031).

use crate::credential::{ProtectedResultBuffer, TaskCredentialRecord};
use crate::engine::TaskStore;
use crate::TaskAccessError;
use opensesame_domain::{
    AcknowledgementSet, CapabilitySet, CapabilityStateTransition, CapabilityStateTransitionId,
    CapabilityTransitionStatus, DomainError, TaskRun, TaskRunId, TaskRunStatus,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::sync::atomic::{AtomicBool, Ordering};

const MIGRATION_0001: &str = include_str!("../migrations/0001_task_access.sql");

/// Identifies which task authority backend is active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskAuthorityBackend {
    InMemory,
    SqliteLocal,
    /// `PostgreSQL` configured; `migrated` is true after `0001_task_access.sql` applied.
    Postgres {
        migrated: bool,
    },
}

/// Returns true only when distributed Postgres task authority is configured and migrated.
#[must_use]
pub fn distributed_task_authority_ok(backend: TaskAuthorityBackend) -> bool {
    matches!(backend, TaskAuthorityBackend::Postgres { migrated: true })
}

#[must_use]
pub fn is_postgres_database_url(url: &str) -> bool {
    !url.is_empty() && (url.starts_with("postgres://") || url.starts_with("postgresql://"))
}

#[must_use]
pub fn task_authority_backend_from_url(url: &str) -> TaskAuthorityBackend {
    if is_postgres_database_url(url) {
        TaskAuthorityBackend::Postgres { migrated: false }
    } else if url.starts_with("sqlite:") {
        TaskAuthorityBackend::SqliteLocal
    } else {
        TaskAuthorityBackend::InMemory
    }
}

/// Marker type documenting the distributed authority backend choice.
#[derive(Clone, Debug, Default)]
pub struct PostgresTaskAuthorityConfig {
    pub database_url: String,
}

impl PostgresTaskAuthorityConfig {
    #[must_use]
    pub fn distributed_ready(&self) -> bool {
        is_postgres_database_url(&self.database_url)
    }
}

/// `PostgreSQL` implementation of [`TaskStore`] with compare-and-swap on `state_version`.
pub struct PostgresTaskStore {
    pool: PgPool,
    migrated: AtomicBool,
}

impl PostgresTaskStore {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn connect(database_url: &str) -> Result<Self, TaskAccessError> {
        if !is_postgres_database_url(database_url) {
            return Err(TaskAccessError::Storage(
                "database_url must be postgres:// or postgresql://".into(),
            ));
        }
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
        let store = Self {
            pool,
            migrated: AtomicBool::new(false),
        };
        store.migrate().await?;
        Ok(store)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn migrate(&self) -> Result<(), TaskAccessError> {
        for stmt in MIGRATION_0001.split(';') {
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

    pub fn distributed_ready(&self) -> bool {
        self.migrated.load(Ordering::SeqCst)
    }

    pub fn authority_backend(&self) -> TaskAuthorityBackend {
        TaskAuthorityBackend::Postgres {
            migrated: self.distributed_ready(),
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    fn block_on<F: std::future::Future<Output = T>, T>(fut: F) -> T {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
            Err(_) => tokio::runtime::Runtime::new()
                .expect("postgres task store runtime")
                .block_on(fut),
        }
    }
}

/// Compile-time reminder that `TaskStore` must not expose `SQLite` pools to domain services.
pub fn assert_store_object_safe<T: TaskStore>() {}

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

fn parse_capability_set(value: serde_json::Value) -> Result<CapabilitySet, TaskAccessError> {
    serde_json::from_value(value).map_err(|e| TaskAccessError::Storage(e.to_string()))
}

fn row_to_run(row: &sqlx::postgres::PgRow) -> Result<TaskRun, TaskAccessError> {
    let ceiling: serde_json::Value = row.get("capability_ceiling");
    let current: serde_json::Value = row.get("current_capabilities");
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
        capability_ceiling: parse_capability_set(ceiling)?,
        current_capabilities: parse_capability_set(current)?,
        state_version: crate::db_u64(row.get::<i64, _>("state_version"))?,
        state_digest: row.get("state_digest"),
        maximum_expires_at: row.get("maximum_expires_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

async fn stored_state_version(pool: &PgPool, task_run_id: &str) -> Result<u64, TaskAccessError> {
    let row = sqlx::query("SELECT state_version FROM task_runs WHERE id = $1")
        .bind(task_run_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| TaskAccessError::Storage(e.to_string()))?
        .ok_or_else(|| TaskAccessError::TaskNotFound(task_run_id.to_string()))?;
    crate::db_u64(row.get::<i64, _>("state_version"))
}

impl TaskStore for PostgresTaskStore {
    fn get_run(&self, id: TaskRunId) -> Result<Option<TaskRun>, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = id.to_string();
        Self::block_on(async move {
            let row = sqlx::query(
                r"
                SELECT id, template_id, organization_id, project_id, principal_id,
                       authority_context_id, status, capability_ceiling, current_capabilities,
                       state_version, state_digest, maximum_expires_at, created_at, updated_at
                FROM task_runs WHERE id = $1
                ",
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
        Self::block_on(async move {
            let existing = sqlx::query(
                "SELECT ceiling_digest, pending_transition_id FROM task_runs WHERE id = $1",
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
                // Derive it rather than storing a placeholder: a row whose digest
                // is empty until the next call fails every later ceiling check.
                None => (run.capability_ceiling.digest()?, None),
            };
            upsert_task_run(&pool, &run, ceiling_digest.as_str(), pending.as_deref()).await
        })
    }

    fn save_run_cas(
        &self,
        run: &TaskRun,
        expected_state_version: u64,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let run = run.clone();
        Self::block_on(async move {
            let result = sqlx::query(
                r"
                UPDATE task_runs SET
                    status = $2,
                    current_capabilities = $3,
                    state_version = $4,
                    state_digest = $5,
                    updated_at = $6
                WHERE id = $1 AND state_version = $7
                ",
            )
            .bind(run.id.to_string())
            .bind(status_to_str(run.status))
            .bind(
                serde_json::to_value(&run.current_capabilities)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(crate::db_i64(run.state_version)?)
            .bind(&run.state_digest)
            .bind(run.updated_at)
            .bind(crate::db_i64(expected_state_version)?)
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;

            if result.rows_affected() == 0 {
                let actual_version = stored_state_version(&pool, &run.id.to_string()).await?;
                return Err(TaskAccessError::Domain(
                    DomainError::TaskStateVersionMismatch {
                        expected: expected_state_version,
                        actual: actual_version,
                    },
                ));
            }
            Ok(())
        })
    }

    fn get_transition(
        &self,
        id: CapabilityStateTransitionId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = id.to_string();
        Self::block_on(async move {
            let row = sqlx::query(
                r"
                SELECT id, task_run_id, from_state_version, to_state_version, status,
                       removed, resulting_capabilities, trigger_evidence_digest,
                       created_at, committed_at
                FROM capability_transitions WHERE id = $1
                ",
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.as_ref().map(row_to_transition).transpose()
        })
    }

    fn save_transition(
        &self,
        transition: &CapabilityStateTransition,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let transition = transition.clone();
        Self::block_on(async move { upsert_transition(&pool, &transition).await })
    }

    fn get_pending_transition(
        &self,
        task_run_id: TaskRunId,
    ) -> Result<Option<CapabilityStateTransition>, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = task_run_id.to_string();
        Self::block_on(async move {
            let row = sqlx::query(
                r"
                SELECT t.id, t.task_run_id, t.from_state_version, t.to_state_version, t.status,
                       t.removed, t.resulting_capabilities, t.trigger_evidence_digest,
                       t.created_at, t.committed_at
                FROM task_runs r
                JOIN capability_transitions t ON t.id = r.pending_transition_id
                WHERE r.id = $1
                ",
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.as_ref().map(row_to_transition).transpose()
        })
    }

    fn get_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
    ) -> Result<AcknowledgementSet, TaskAccessError> {
        let pool = self.pool.clone();
        let id_str = transition_id.to_string();
        Self::block_on(async move {
            let row =
                sqlx::query("SELECT required, received FROM ack_sets WHERE transition_id = $1")
                    .bind(&id_str)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            match row {
                Some(row) => {
                    let required: serde_json::Value = row.get("required");
                    let received: serde_json::Value = row.get("received");
                    Ok(AcknowledgementSet {
                        required: serde_json::from_value(required)
                            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                        received: serde_json::from_value(received)
                            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
                    })
                }
                None => Ok(AcknowledgementSet::default()),
            }
        })
    }

    fn save_ack_set(
        &self,
        transition_id: CapabilityStateTransitionId,
        set: &AcknowledgementSet,
    ) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let transition_id = transition_id.to_string();
        let set = set.clone();
        Self::block_on(async move {
            sqlx::query(
                r"
                INSERT INTO ack_sets (transition_id, required, received)
                VALUES ($1, $2, $3)
                ON CONFLICT (transition_id) DO UPDATE SET
                    required = EXCLUDED.required,
                    received = EXCLUDED.received
                ",
            )
            .bind(&transition_id)
            .bind(
                serde_json::to_value(&set.required)
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
            )
            .bind(
                serde_json::to_value(&set.received)
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
        let id_str = task_run_id.to_string();
        Self::block_on(async move {
            let row = sqlx::query(
                r"
                SELECT task_run_id, transition_id, state_version, result_digest,
                       payload, released, created_at
                FROM result_buffers WHERE task_run_id = $1
                ",
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.map(|row| {
                Ok(ProtectedResultBuffer {
                    task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                    transition_id: row.get("transition_id"),
                    state_version: crate::db_u64(row.get::<i64, _>("state_version"))?,
                    result_digest: row.get("result_digest"),
                    payload: row.get("payload"),
                    created_at: row.get("created_at"),
                    released: row.get("released"),
                })
            })
            .transpose()
        })
    }

    fn save_result_buffer(&self, buffer: &ProtectedResultBuffer) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let buffer = buffer.clone();
        Self::block_on(async move {
            sqlx::query(
                r"
                INSERT INTO result_buffers
                    (task_run_id, transition_id, state_version, result_digest, payload, released, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (task_run_id) DO UPDATE SET
                    transition_id = EXCLUDED.transition_id,
                    state_version = EXCLUDED.state_version,
                    result_digest = EXCLUDED.result_digest,
                    payload = EXCLUDED.payload,
                    released = EXCLUDED.released,
                    created_at = EXCLUDED.created_at
                ",
            )
            .bind(buffer.task_run_id.to_string())
            .bind(&buffer.transition_id)
            .bind(crate::db_i64(buffer.state_version)?)
            .bind(&buffer.result_digest)
            .bind(&buffer.payload)
            .bind(buffer.released)
            .bind(buffer.created_at)
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
        let id_str = task_run_id.to_string();
        Self::block_on(async move {
            let row = sqlx::query(
                r"
                SELECT id, task_run_id, credential_digest, state_version, issued_at, expires_at
                FROM task_credentials
                WHERE task_run_id = $1
                ORDER BY issued_at DESC
                LIMIT 1
                ",
            )
            .bind(&id_str)
            .fetch_optional(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            row.map(|row| {
                Ok(TaskCredentialRecord {
                    id: opensesame_domain::TaskCredentialId::parse(&row.get::<String, _>("id"))?,
                    task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
                    credential_digest: row.get("credential_digest"),
                    state_version: crate::db_u64(row.get::<i64, _>("state_version"))?,
                    issued_at: row.get("issued_at"),
                    expires_at: row.get("expires_at"),
                })
            })
            .transpose()
        })
    }

    fn save_credential(&self, record: &TaskCredentialRecord) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        let record = record.clone();
        Self::block_on(async move {
            sqlx::query(
                r"
                INSERT INTO task_credentials
                    (id, task_run_id, credential_digest, state_version, issued_at, expires_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                    credential_digest = EXCLUDED.credential_digest,
                    state_version = EXCLUDED.state_version,
                    issued_at = EXCLUDED.issued_at,
                    expires_at = EXCLUDED.expires_at
                ",
            )
            .bind(record.id.to_string())
            .bind(record.task_run_id.to_string())
            .bind(&record.credential_digest)
            .bind(crate::db_i64(record.state_version)?)
            .bind(record.issued_at)
            .bind(record.expires_at)
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
        let id_str = task_run_id.to_string();
        Self::block_on(async move {
            let row = sqlx::query("SELECT ceiling_digest FROM task_runs WHERE id = $1")
                .bind(&id_str)
                .fetch_optional(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(row.map(|r| r.get::<String, _>("ceiling_digest")))
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
        let id_str = task_run_id.to_string();
        let digest = digest.to_string();
        Self::block_on(async move {
            let updated = sqlx::query(
                r"
                UPDATE task_runs SET ceiling_digest = $2
                WHERE id = $1 AND (ceiling_digest = '' OR ceiling_digest = $2)
                ",
            )
            .bind(&id_str)
            .bind(&digest)
            .execute(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            if updated.rows_affected() == 0 {
                let existing = sqlx::query("SELECT ceiling_digest FROM task_runs WHERE id = $1")
                    .bind(&id_str)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
                return match existing {
                    Some(_) => Err(TaskAccessError::CeilingImmutable),
                    None => Err(TaskAccessError::TaskNotFound(id_str)),
                };
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
        Self::block_on(async move {
            sqlx::query("UPDATE task_runs SET pending_transition_id = $2 WHERE id = $1")
                .bind(task_run_id.to_string())
                .bind(transition_id.to_string())
                .execute(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn clear_pending_transition(&self, task_run_id: TaskRunId) -> Result<(), TaskAccessError> {
        let pool = self.pool.clone();
        Self::block_on(async move {
            sqlx::query("UPDATE task_runs SET pending_transition_id = NULL WHERE id = $1")
                .bind(task_run_id.to_string())
                .execute(&pool)
                .await
                .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            Ok(())
        })
    }

    fn list_runs(&self) -> Result<Vec<TaskRun>, TaskAccessError> {
        let pool = self.pool.clone();
        Self::block_on(async move {
            let rows = sqlx::query(
                r"
                SELECT id, template_id, organization_id, project_id, principal_id,
                       authority_context_id, status, capability_ceiling, current_capabilities,
                       state_version, state_digest, maximum_expires_at, created_at, updated_at
                FROM task_runs ORDER BY created_at DESC
                ",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
            rows.iter().map(row_to_run).collect()
        })
    }
}

fn row_to_transition(
    row: &sqlx::postgres::PgRow,
) -> Result<CapabilityStateTransition, TaskAccessError> {
    let removed: serde_json::Value = row.get("removed");
    let resulting: serde_json::Value = row.get("resulting_capabilities");
    Ok(CapabilityStateTransition {
        id: CapabilityStateTransitionId::parse(&row.get::<String, _>("id"))?,
        task_run_id: TaskRunId::parse(&row.get::<String, _>("task_run_id"))?,
        from_state_version: crate::db_u64(row.get::<i64, _>("from_state_version"))?,
        to_state_version: crate::db_u64(row.get::<i64, _>("to_state_version"))?,
        status: transition_status_from_str(row.get::<String, _>("status").as_str())?,
        removed: parse_capability_set(removed)?,
        resulting_capabilities: parse_capability_set(resulting)?,
        trigger_evidence_digest: row.get("trigger_evidence_digest"),
        created_at: row.get("created_at"),
        committed_at: row.get("committed_at"),
    })
}

async fn upsert_task_run(
    pool: &PgPool,
    run: &TaskRun,
    ceiling_digest: &str,
    pending_transition_id: Option<&str>,
) -> Result<(), TaskAccessError> {
    sqlx::query(
        r"
        INSERT INTO task_runs (
            id, template_id, organization_id, project_id, principal_id, authority_context_id,
            status, capability_ceiling, current_capabilities, state_version, state_digest,
            ceiling_digest, maximum_expires_at, pending_transition_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        -- The ceiling and its digest are absent here on purpose: a ceiling is
        -- immutable after activation (ADR 0019), so an upsert must not be a way
        -- to widen one.
        ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            current_capabilities = EXCLUDED.current_capabilities,
            state_version = EXCLUDED.state_version,
            state_digest = EXCLUDED.state_digest,
            maximum_expires_at = EXCLUDED.maximum_expires_at,
            pending_transition_id = EXCLUDED.pending_transition_id,
            updated_at = EXCLUDED.updated_at
        ",
    )
    .bind(run.id.to_string())
    .bind(run.template_id.to_string())
    .bind(run.organization_id.to_string())
    .bind(run.project_id.map(|p| p.to_string()))
    .bind(run.principal_id.to_string())
    .bind(run.authority_context_id.to_string())
    .bind(status_to_str(run.status))
    .bind(
        serde_json::to_value(&run.capability_ceiling)
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
    )
    .bind(
        serde_json::to_value(&run.current_capabilities)
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
    )
    .bind(crate::db_i64(run.state_version)?)
    .bind(&run.state_digest)
    .bind(ceiling_digest)
    .bind(run.maximum_expires_at)
    .bind(pending_transition_id)
    .bind(run.created_at)
    .bind(run.updated_at)
    .execute(pool)
    .await
    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
    Ok(())
}

async fn upsert_transition(
    pool: &PgPool,
    transition: &CapabilityStateTransition,
) -> Result<(), TaskAccessError> {
    sqlx::query(
        r"
        INSERT INTO capability_transitions (
            id, task_run_id, from_state_version, to_state_version, status,
            removed, resulting_capabilities, trigger_evidence_digest, created_at, committed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            removed = EXCLUDED.removed,
            resulting_capabilities = EXCLUDED.resulting_capabilities,
            trigger_evidence_digest = EXCLUDED.trigger_evidence_digest,
            committed_at = EXCLUDED.committed_at
        ",
    )
    .bind(transition.id.to_string())
    .bind(transition.task_run_id.to_string())
    .bind(crate::db_i64(transition.from_state_version)?)
    .bind(crate::db_i64(transition.to_state_version)?)
    .bind(transition_status_to_str(transition.status))
    .bind(
        serde_json::to_value(&transition.removed)
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
    )
    .bind(
        serde_json::to_value(&transition.resulting_capabilities)
            .map_err(|e| TaskAccessError::Storage(e.to_string()))?,
    )
    .bind(&transition.trigger_evidence_digest)
    .bind(transition.created_at)
    .bind(transition.committed_at)
    .execute(pool)
    .await
    .map_err(|e| TaskAccessError::Storage(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::InMemoryTaskStore;

    #[test]
    fn postgres_url_marks_distributed_ready() {
        let cfg = PostgresTaskAuthorityConfig {
            database_url: "postgres://localhost/opensesame".into(),
        };
        assert!(cfg.distributed_ready());
        let sqlite = PostgresTaskAuthorityConfig {
            database_url: "sqlite::memory:".into(),
        };
        assert!(!sqlite.distributed_ready());
    }

    #[test]
    fn distributed_task_authority_ok_only_postgres() {
        assert!(!distributed_task_authority_ok(
            TaskAuthorityBackend::InMemory
        ));
        assert!(!distributed_task_authority_ok(
            TaskAuthorityBackend::SqliteLocal
        ));
        assert!(!distributed_task_authority_ok(
            TaskAuthorityBackend::Postgres { migrated: false }
        ));
        assert!(distributed_task_authority_ok(
            TaskAuthorityBackend::Postgres { migrated: true }
        ));
    }

    #[test]
    fn in_memory_store_is_object_safe() {
        assert_store_object_safe::<InMemoryTaskStore>();
        assert_store_object_safe::<PostgresTaskStore>();
    }

    /// Live Postgres CAS — enabled with `--features postgres-integration` and
    /// `OPENSESAME_TEST_DATABASE_URL`. Durable CAS is covered mandatorily by
    /// `sqlite_store::tests::sqlite_store_round_trip_cas_and_fence`.
    #[tokio::test]
    #[cfg(feature = "postgres-integration")]
    async fn postgres_store_round_trip_and_cas() {
        use crate::{ProposeRestrictionParams, StartTaskParams, TaskAccessEngine, TaskAccessError};
        use chrono::{Duration, Utc};
        use opensesame_domain::{
            AuthorityContext, AuthorityContextId, AuthorityContextMode, Capability, CapabilitySet,
            CeilingInput, DomainError, OrganizationId, PrincipalId, ResourceSelector,
            TaskTemplateId,
        };

        let url = std::env::var("OPENSESAME_TEST_DATABASE_URL")
            .expect("set OPENSESAME_TEST_DATABASE_URL for postgres-integration feature");
        let store = PostgresTaskStore::connect(&url).await.unwrap();
        assert!(distributed_task_authority_ok(store.authority_backend()));
        let engine = TaskAccessEngine::new(store);
        let now = Utc::now();
        let principal = PrincipalId::new();
        let caps = CapabilitySet::new(vec![Capability::new(
            "read",
            ResourceSelector::exact("repo:a"),
        )]);
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
        assert_eq!(run.state_version, 1);

        let loaded = engine.store().get_run(run.id).unwrap().unwrap();
        assert_eq!(loaded.id, run.id);

        let mut stale = loaded;
        stale.state_version = 2;
        stale.updated_at = Utc::now();
        let err = engine.store().save_run_cas(&stale, 1).unwrap_err();
        assert!(matches!(
            err,
            TaskAccessError::Domain(DomainError::TaskStateVersionMismatch { .. })
        ));

        let _ = engine.propose_restriction(ProposeRestrictionParams {
            task_run_id: run.id,
            expected_state_version: 1,
            proposed_capabilities: CapabilitySet::new(vec![Capability::new(
                "read",
                ResourceSelector::exact("repo:a"),
            )]),
            required_mediation: vec![],
            result_payload: None,
            now,
        });
    }
}
