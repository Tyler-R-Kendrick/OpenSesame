//! Connection credential rotation (Doppler-parity capability under ADR 0005).
//!
//! Durable, pool-backed policies and jobs (WP-9). Each executed job is driven
//! through the `opensesame-rotation` verify-before-revoke state machine and
//! **every transition is persisted** to `rotation_jobs.state`, so a restart
//! resumes from durable state instead of forgetting in-flight work. Events are
//! emitted on a [`TaskBus`] as CloudEvents-shaped payloads and recorded in the
//! durable changelog under the frozen `credential.rotation.*` names. New secret
//! material is never placed on the bus, in the changelog, or in API-facing
//! views — only ids, states, and operator hints.

use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_rotation::RotationState;
use opensesame_task_bus::{BusEvent, TaskBus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::changelog_hook::RecordSecretChangelog;
use crate::error::{BrokerError, Result};
use crate::model::ConnectionView;
use crate::rotation_verify::{VerifyOutcome, VERIFY_SKIPPED_DETAIL};
use crate::store;
use crate::ConnectionBroker;

/// Frozen domain event type strings (WP-B / WP-E).
pub const EVENT_ROTATION_REQUESTED: &str = "credential.rotation.requested";
pub const EVENT_ROTATION_SUCCEEDED: &str = "credential.rotation.succeeded";
pub const EVENT_ROTATION_FAILED: &str = "credential.rotation.failed";

const BUS_SOURCE: &str = "opensesame://connection-broker/rotation";

/// Job state persisted before the machine starts executing.
const STATE_SCHEDULED: &str = "scheduled";

/// Detail recorded for deferred sealed-store rotations.
const STORE_PATH_DEFERRAL_DETAIL: &str = "store_path rotation requires the sealed-store CLI";

/// Parked when a web-login policy is due but no sandbox runner is configured.
/// ADR 0076 T5: a target with no way through notifies and parks. It never
/// improvises, and it never reports success it did not have.
const WEB_LOGIN_NO_RUNNER_DETAIL: &str = "web_login rotation requires a configured sandbox runner";

/// Longest error hint persisted on a job — a hint, never token material.
const MAX_DETAIL_CHARS: usize = 160;

/// What to rotate — connection credentials, a sealed-store path, or a password
/// at a relying party (metadata only; never a value).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RotationTarget {
    Connection {
        connection_id: String,
    },
    StorePath {
        path: String,
    },
    /// A web login at a third party (ADR 0076). The target id is the relying
    /// party's origin, which is the unit a recipe, a per-domain opt-in and a
    /// rate limit are all scoped to. It is never a username and never a path:
    /// an origin is the most that can be said about a web login without saying
    /// something about the account.
    WebLogin {
        origin: String,
    },
}

impl RotationTarget {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Connection { .. } => "connection",
            Self::StorePath { .. } => "store_path",
            Self::WebLogin { .. } => "web_login",
        }
    }

    #[must_use]
    pub fn target_id(&self) -> &str {
        match self {
            Self::Connection { connection_id } => connection_id,
            Self::StorePath { path } => path,
            Self::WebLogin { origin } => origin,
        }
    }

    #[must_use]
    pub fn from_parts(kind: &str, target_id: &str) -> Option<Self> {
        match kind {
            "connection" => Some(Self::Connection {
                connection_id: target_id.to_string(),
            }),
            "store_path" => Some(Self::StorePath {
                path: target_id.to_string(),
            }),
            "web_login" => Some(Self::WebLogin {
                origin: target_id.to_string(),
            }),
            _ => None,
        }
    }
}

/// Durable schedule without secrets (backed by `rotation_policies`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RotationPolicy {
    pub id: String,
    pub organization_id: String,
    pub target: RotationTarget,
    /// The principal this rotates for, when the policy names one.
    pub owner_subject: Option<String>,
    pub interval_seconds: u64,
    pub last_rotated_at: Option<String>,
    pub enabled: bool,
    /// Consecutive failed attempts; 0 after any success.
    pub attempts: i64,
    /// Earliest time the scheduler may claim this policy again.
    pub next_attempt_at: Option<String>,
    /// Attempts exhausted. The policy stays enabled and stops retrying, so a
    /// rotation that is not happening stays visible instead of disappearing.
    pub needs_attention: bool,
    /// Truncated, value-blind hint from the last failure. Never a response body.
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl RotationPolicy {
    #[must_use]
    pub fn interval_duration(&self) -> Duration {
        Duration::from_secs(self.interval_seconds.max(1))
    }

    #[must_use]
    pub fn last_rotated(&self) -> Option<DateTime<Utc>> {
        self.last_rotated_at
            .as_deref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
            .map(|t| t.with_timezone(&Utc))
    }

    /// JSON safe for HTTP / agents — strips any accidental secret-shaped keys.
    #[must_use]
    pub fn public_view(&self) -> Value {
        strip_secret_shaped_keys(serde_json::to_value(self).unwrap_or_else(|_| json!({})))
    }

    fn from_row(row: store::RotationPolicyRow) -> Option<Self> {
        Some(Self {
            target: RotationTarget::from_parts(&row.target_kind, &row.target_id)?,
            id: row.id,
            organization_id: row.organization_id,
            owner_subject: row.owner_subject,
            interval_seconds: u64::try_from(row.interval_seconds.max(1)).ok()?,
            last_rotated_at: row.last_rotated_at,
            enabled: row.enabled,
            attempts: row.attempts,
            next_attempt_at: row.next_attempt_at,
            needs_attention: row.needs_attention,
            last_error: row.last_error,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        })
    }
}

/// Fields for [`ConnectionBroker::upsert_rotation_policy`]. `id: None` creates.
#[derive(Clone, Debug)]
pub struct UpsertRotationPolicy {
    pub id: Option<String>,
    pub target: RotationTarget,
    /// Who this rotates for. Required for a `web_login` target and optional for
    /// the rest — see [`ConnectionBroker::upsert_rotation_policy`].
    pub owner_subject: Option<String>,
    pub interval_seconds: u64,
    pub enabled: bool,
}

/// Coarse operator status derived from the persisted machine state.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RotationStatus {
    Requested,
    Succeeded,
    Failed,
}

impl RotationStatus {
    fn from_state(state: &str) -> Self {
        match state {
            "completed" => Self::Succeeded,
            "rollback_completed" | "rollback_failed" | "reconciliation_required" => Self::Failed,
            _ => Self::Requested,
        }
    }
}

/// Operator-visible rotation job (backed by `rotation_jobs`). Never carries
/// secret values.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RotationJob {
    pub id: String,
    pub policy_id: Option<String>,
    pub organization_id: String,
    pub target: RotationTarget,
    /// Persisted [`RotationState`] name (`snake_case`), or `scheduled`.
    pub state: String,
    pub status: RotationStatus,
    pub detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl RotationJob {
    /// JSON safe for HTTP / agents — strips any accidental secret-shaped keys.
    #[must_use]
    pub fn public_view(&self) -> Value {
        strip_secret_shaped_keys(serde_json::to_value(self).unwrap_or_else(|_| json!({})))
    }

    fn from_row(row: store::RotationJobRow) -> Option<Self> {
        Some(Self {
            target: RotationTarget::from_parts(&row.target_kind, &row.target_id)?,
            status: RotationStatus::from_state(&row.state),
            id: row.id,
            policy_id: row.policy_id,
            organization_id: row.organization_id,
            state: row.state,
            detail: row.detail,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        })
    }
}

fn strip_secret_shaped_keys(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        for forbidden in [
            "secret",
            "value",
            "password",
            "token",
            "access_token",
            "refresh_token",
            "client_secret",
            "api_key",
        ] {
            obj.remove(forbidden);
        }
    }
    value
}

/// Parse a simple interval (`30s`, `5m`, `1h`, `24h`, `7d`, or raw seconds).
#[must_use]
pub fn parse_interval(raw: &str) -> Option<Duration> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(Duration::from_secs(secs.max(1)));
    }
    let (num, unit) = trimmed.split_at(trimmed.len().saturating_sub(1));
    let n: u64 = num.parse().ok()?;
    match unit {
        "s" | "S" => Some(Duration::from_secs(n.max(1))),
        "m" | "M" => Some(Duration::from_secs(n.saturating_mul(60).max(1))),
        "h" | "H" => Some(Duration::from_secs(n.saturating_mul(3600).max(1))),
        "d" | "D" => Some(Duration::from_secs(n.saturating_mul(86_400).max(1))),
        _ => None,
    }
}

/// Whether a wall-clock instant is due for a policy (used by the scheduler —
/// the gateway's rotation tick is the production caller).
#[must_use]
pub fn policy_due_at(
    policy: &RotationPolicy,
    last_run: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if !policy.enabled {
        return false;
    }
    let interval = policy.interval_duration();
    match last_run {
        None => true,
        Some(last) => now >= last + chrono::Duration::from_std(interval).unwrap_or_default(),
    }
}

fn state_name(state: RotationState) -> &'static str {
    match state {
        RotationState::Scheduled => "scheduled",
        RotationState::Discovering => "discovering",
        RotationState::CandidateGenerated => "candidate_generated",
        RotationState::CandidateInstalled => "candidate_installed",
        RotationState::CandidateVerified => "candidate_verified",
        RotationState::CandidateActivated => "candidate_activated",
        RotationState::DependentsUpdated => "dependents_updated",
        RotationState::Observing => "observing",
        RotationState::PreviousRevoked => "previous_revoked",
        RotationState::RevocationVerified => "revocation_verified",
        RotationState::Completed => "completed",
        RotationState::RollbackStarted => "rollback_started",
        RotationState::RollbackCompleted => "rollback_completed",
        RotationState::RollbackFailed => "rollback_failed",
        RotationState::ReconciliationRequired => "reconciliation_required",
    }
}

fn truncate_detail(raw: &str) -> String {
    raw.chars().take(MAX_DETAIL_CHARS).collect()
}

fn bus_event(r#type: &str, data: Value) -> BusEvent {
    BusEvent {
        id: format!("evt_{}", Uuid::now_v7()),
        specversion: "1.0".into(),
        source: BUS_SOURCE.into(),
        r#type: r#type.into(),
        time: Utc::now().to_rfc3339(),
        data,
    }
}

fn job_event_data(job: &RotationJob) -> Value {
    json!({
        "rotation_id": job.id,
        "policy_id": job.policy_id,
        "state": job.state,
        "status": job.status,
        "target": job.target,
        "organization_id": job.organization_id,
        "detail": job.detail,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    })
}

/// Record a `credential.rotation.*` row in the durable changelog. Best-effort
/// at emission sites: a changelog write failure never poisons the rotation.
async fn record_rotation_changelog(
    broker: &ConnectionBroker,
    event_type: &str,
    job: &RotationJob,
    project_id: Option<&str>,
    version_id: Option<String>,
) {
    let metadata = Map::from_iter([
        ("rotation_id".into(), json!(job.id)),
        ("target_kind".into(), json!(job.target.kind())),
        ("final_state".into(), json!(job.state)),
    ]);
    if let Err(error) = broker
        .record_changelog(RecordSecretChangelog {
            event_type: event_type.into(),
            project_id: project_id.unwrap_or("unknown").to_string(),
            organization_id: Some(job.organization_id.clone()),
            target_id: Some(job.target.target_id().to_string()),
            version_id,
            metadata,
            ..Default::default()
        })
        .await
    {
        tracing::warn!(
            rotation_id = %job.id,
            error = %error.hint(),
            "rotation changelog write failed"
        );
    }
}

/// Durable rotation policy + job surface on the broker.
impl ConnectionBroker {
    /// # Errors
    ///
    /// Returns an error when policy validation or durable persistence fails.
    pub async fn upsert_rotation_policy(
        &self,
        organization_id: &str,
        upsert: UpsertRotationPolicy,
    ) -> Result<RotationPolicy> {
        if upsert.interval_seconds == 0 {
            return Err(BrokerError::Invalid(
                "rotation interval must be at least one second".into(),
            ));
        }
        // A web-login run is observed, and only its owner may observe it
        // (ADR 0081 §8). A policy with no owner would produce runs nobody is
        // entitled to watch and nobody can be notified about — so it is refused
        // here, at the one moment a person is present to answer, rather than
        // discovered when a run gets stuck at four in the morning.
        let names_an_owner = upsert
            .owner_subject
            .as_deref()
            .is_some_and(|owner| !owner.trim().is_empty());
        if matches!(upsert.target, RotationTarget::WebLogin { .. }) && !names_an_owner {
            return Err(BrokerError::Invalid(
                "a web_login rotation policy must name the principal it rotates for".into(),
            ));
        }
        let now = Utc::now();
        let (id, created_at, last_rotated_at) = match upsert.id {
            Some(id) => {
                let existing = store::get_rotation_policy(&self.pool, &id)
                    .await?
                    .filter(|row| row.organization_id == organization_id)
                    .ok_or_else(|| {
                        BrokerError::Invalid(format!("rotation policy `{id}` not found"))
                    })?;
                (existing.id, existing.created_at, existing.last_rotated_at)
            }
            None => (format!("rotpol_{}", Uuid::now_v7()), now, None),
        };
        let row = store::RotationPolicyRow {
            id,
            organization_id: organization_id.to_string(),
            target_kind: upsert.target.kind().to_string(),
            target_id: upsert.target.target_id().to_string(),
            owner_subject: upsert.owner_subject,
            interval_seconds: i64::try_from(upsert.interval_seconds).unwrap_or(i64::MAX),
            last_rotated_at,
            enabled: upsert.enabled,
            // Saving a policy is a deliberate operator act, so it starts from a
            // clean slate; the ON CONFLICT clause clears any park in place.
            lease_until: None,
            attempts: 0,
            next_attempt_at: None,
            needs_attention: false,
            last_error: None,
            created_at,
            updated_at: now,
        };
        store::upsert_rotation_policy(&self.pool, &row).await?;
        RotationPolicy::from_row(row)
            .ok_or_else(|| BrokerError::Invalid("rotation target kind is unknown".into()))
    }

    /// # Errors
    ///
    /// Returns an error when durable policy storage cannot be read.
    pub async fn list_rotation_policies(
        &self,
        organization_id: &str,
    ) -> Result<Vec<RotationPolicy>> {
        Ok(store::list_rotation_policies(&self.pool, organization_id)
            .await?
            .into_iter()
            .filter_map(RotationPolicy::from_row)
            .collect())
    }

    /// Enabled policies across every organization — the scheduler's read.
    ///
    /// # Errors
    ///
    /// Returns an error when durable policy storage cannot be read.
    pub async fn list_enabled_rotation_policies(&self) -> Result<Vec<RotationPolicy>> {
        Ok(store::list_enabled_rotation_policies(&self.pool)
            .await?
            .into_iter()
            .filter_map(RotationPolicy::from_row)
            .collect())
    }

    /// # Errors
    ///
    /// Returns an error when the durable policy timestamp cannot be updated.
    pub async fn set_policy_last_rotated(&self, id: &str, at: DateTime<Utc>) -> Result<()> {
        store::set_policy_last_rotated(&self.pool, id, &at.to_rfc3339()).await
    }

    /// Leases one rotation policy. `true` means this caller may act on it.
    ///
    /// The lifecycle scanner (ADR 0074) decides *when* a policy is due; this
    /// decides *who* acts, and refuses a policy that is leased elsewhere,
    /// backing off, or parked. Without it two gateway processes both rotate the
    /// same credential, which for a password change is a lockout.
    ///
    /// # Errors
    ///
    /// Returns an error when the claim transaction fails.
    pub async fn claim_rotation_policy(&self, id: &str, lease_seconds: i64) -> Result<bool> {
        store::claim_rotation_policy(&self.pool, id, lease_seconds).await
    }

    /// Releases a claimed policy after a successful rotation.
    ///
    /// # Errors
    ///
    /// Returns an error when the release update fails.
    pub async fn release_rotation_policy_success(
        &self,
        policy: &RotationPolicy,
        rotated_at: DateTime<Utc>,
    ) -> Result<()> {
        let interval = i64::try_from(policy.interval_seconds).unwrap_or(i64::MAX);
        store::release_rotation_policy_success(&self.pool, &policy.id, rotated_at, interval).await
    }

    /// Releases a claimed policy after a failure. `next_attempt_at: None` parks
    /// the policy: it stops retrying, stays enabled, and raises
    /// `needs_attention`. The reason is truncated here so no caller can widen
    /// what a durable row carries.
    ///
    /// # Errors
    ///
    /// Returns an error when the release update fails.
    pub async fn release_rotation_policy_failure(
        &self,
        policy_id: &str,
        next_attempt_at: Option<DateTime<Utc>>,
        reason: &str,
    ) -> Result<()> {
        store::release_rotation_policy_failure(
            &self.pool,
            policy_id,
            next_attempt_at,
            &truncate_detail(reason),
        )
        .await
    }

    /// # Errors
    ///
    /// Returns an error when durable job storage cannot be read.
    pub async fn list_rotation_jobs(
        &self,
        organization_id: &str,
        limit: usize,
    ) -> Result<Vec<RotationJob>> {
        Ok(store::list_rotation_jobs(
            &self.pool,
            organization_id,
            i64::try_from(limit.clamp(1, 500)).unwrap_or(500),
        )
        .await?
        .into_iter()
        .filter_map(RotationJob::from_row)
        .collect())
    }

    /// Organization-scoped read; a job in another tenant reads as absent.
    ///
    /// # Errors
    ///
    /// Returns an error when durable job storage cannot be read.
    pub async fn get_rotation_job(
        &self,
        organization_id: &str,
        id: &str,
    ) -> Result<Option<RotationJob>> {
        Ok(store::get_rotation_job(&self.pool, id)
            .await?
            .filter(|row| row.organization_id == organization_id)
            .and_then(RotationJob::from_row))
    }
}

/// Request a rotation: persist a durable job (state `scheduled`), record
/// `credential.rotation.requested` in the changelog, then publish the bus
/// event. The job is durable before the bus write — a partitioned bus
/// surfaces the error but never loses the job.
///
/// # Errors
///
/// Returns an error when durable persistence or request-event publication fails.
pub async fn request_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    target: RotationTarget,
    project_id: Option<String>,
    organization_id: &str,
    policy_id: Option<String>,
) -> Result<RotationJob> {
    let now = Utc::now();
    let row = store::RotationJobRow {
        id: format!("rot_{}", Uuid::now_v7()),
        policy_id,
        organization_id: organization_id.to_string(),
        target_kind: target.kind().to_string(),
        target_id: target.target_id().to_string(),
        state: STATE_SCHEDULED.into(),
        detail: None,
        created_at: now,
        updated_at: now,
    };
    store::insert_rotation_job(&broker.pool, &row).await?;
    let job = RotationJob::from_row(row)
        .ok_or_else(|| BrokerError::Invalid("rotation target kind is unknown".into()))?;
    record_rotation_changelog(
        broker,
        EVENT_ROTATION_REQUESTED,
        &job,
        project_id.as_deref(),
        None,
    )
    .await;
    bus.publish(bus_event(EVENT_ROTATION_REQUESTED, job_event_data(&job)))
        .await
        .map_err(|error| BrokerError::Invalid(format!("bus publish failed: {error}")))?;
    Ok(job)
}

/// Execute one pending rotation job, dispatching on its target kind.
///
/// # Errors
///
/// Returns an error when the job is invalid or its target cannot be rotated.
pub async fn execute_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    let job = load_scheduled_job(broker, organization_id, job_id).await?;
    match &job.target {
        RotationTarget::Connection { .. } => {
            execute_connection_rotation(broker, bus, organization_id, job_id).await
        }
        RotationTarget::StorePath { .. } => {
            defer_store_path_rotation(broker, bus, organization_id, job).await
        }
        RotationTarget::WebLogin { .. } => {
            defer_rotation(
                broker,
                bus,
                organization_id,
                job,
                WEB_LOGIN_NO_RUNNER_DETAIL,
            )
            .await
        }
    }
}

async fn load_scheduled_job(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    let job = broker
        .get_rotation_job(&organization_id.to_string(), job_id)
        .await?
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{job_id}` not found")))?;
    if job.state != STATE_SCHEDULED {
        return Err(BrokerError::Invalid(format!(
            "rotation job `{job_id}` is already `{}`",
            job.state
        )));
    }
    Ok(job)
}

/// Honest deferral: the Host cannot regenerate sealed-store material (the
/// sealed-store CLI owns that path), so the job parks in
/// `reconciliation_required` for operator attention instead of pretending.
async fn defer_store_path_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job: RotationJob,
) -> Result<RotationJob> {
    defer_rotation(
        broker,
        bus,
        organization_id,
        job,
        STORE_PATH_DEFERRAL_DETAIL,
    )
    .await
}

/// Park a job with a value-blind reason and tell everyone who is listening.
///
/// The publish is not optional decoration: a rotation that is not happening has
/// to stay visible, which is the same rule that makes `needs_attention` a
/// column rather than a log line.
async fn defer_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job: RotationJob,
    detail: &str,
) -> Result<RotationJob> {
    store::update_rotation_job_state(
        &broker.pool,
        &job.id,
        state_name(RotationState::ReconciliationRequired),
        Some(detail),
    )
    .await?;
    let job = broker
        .get_rotation_job(&organization_id.to_string(), &job.id)
        .await?
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{}` not found", job.id)))?;
    record_rotation_changelog(broker, EVENT_ROTATION_FAILED, &job, None, None).await;
    let _ = bus
        .publish(bus_event(EVENT_ROTATION_FAILED, job_event_data(&job)))
        .await;
    Ok(job)
}

struct SuccessfulRotation<'a> {
    broker: &'a ConnectionBroker,
    bus: &'a dyn TaskBus,
    organization_id: &'a str,
    job_id: &'a str,
    connection_id: &'a str,
    project_id: Option<&'a str>,
}

/// Walks `CandidateInstalled -> CandidateVerified`, or parks the job when the
/// provider rejects the freshly installed credential.
///
/// A rejection cannot be rolled back: `refresh` already activated the new
/// token at the provider, so the honest state is `ReconciliationRequired` — we
/// do not know which credential is live, and the previous value stays retained
/// for a human. The machine permits `CandidateInstalled ->
/// ReconciliationRequired` for exactly this case.
async fn verify_candidate(
    context: &SuccessfulRotation<'_>,
    state: &mut RotationState,
) -> Result<()> {
    let outcome = match OrganizationId::parse(context.organization_id) {
        Ok(organization) => context
            .broker
            .verify_rotated_credential(&organization, context.connection_id)
            .await
            .unwrap_or_else(|error| {
                VerifyOutcome::Failed(format!("verify failed: {}", error.hint()))
            }),
        // A non-canonical organization id cannot be verified against, but it is
        // not evidence the credential is bad.
        Err(_) => VerifyOutcome::Skipped(VERIFY_SKIPPED_DETAIL),
    };

    match outcome {
        VerifyOutcome::Verified => {
            advance(
                context.broker,
                context.job_id,
                state,
                RotationState::CandidateVerified,
                None,
            )
            .await
        }
        VerifyOutcome::Skipped(detail) => {
            advance(
                context.broker,
                context.job_id,
                state,
                RotationState::CandidateVerified,
                Some(detail),
            )
            .await
        }
        VerifyOutcome::Failed(hint) => {
            let detail = truncate_detail(&hint);
            advance(
                context.broker,
                context.job_id,
                state,
                RotationState::ReconciliationRequired,
                Some(&detail),
            )
            .await?;
            finish(
                context.broker,
                context.bus,
                context.organization_id,
                context.job_id,
                EVENT_ROTATION_FAILED,
                context.project_id,
                None,
            )
            .await?;
            Err(BrokerError::Invalid(detail))
        }
    }
}

async fn complete_successful_rotation(
    context: SuccessfulRotation<'_>,
    state: &mut RotationState,
    view: &ConnectionView,
) -> Result<RotationJob> {
    for to in [
        RotationState::CandidateGenerated,
        RotationState::CandidateInstalled,
    ] {
        advance(context.broker, context.job_id, state, to, None).await?;
    }

    // Verify before activating (ADR 0076). `PreviousRevoked` is unreachable
    // without passing `CandidateVerified`, so this edge is what makes the
    // machine's verify-before-revoke guarantee mean something. A provider with
    // no verification endpoint still records the honest skip.
    verify_candidate(&context, state).await?;

    advance(
        context.broker,
        context.job_id,
        state,
        RotationState::CandidateActivated,
        None,
    )
    .await?;
    match store::append_config_sync_dirty_for_connection(
        &context.broker.pool,
        context.organization_id,
        context.connection_id,
    )
    .await
    {
        Ok(dirtied) => {
            tracing::debug!(
                rotation_id = %context.job_id,
                dirtied,
                "rotation marked dependent configs dirty"
            );
        }
        Err(error) => {
            let detail = truncate_detail(&format!("dependents update failed: {}", error.hint()));
            advance(
                context.broker,
                context.job_id,
                state,
                RotationState::ReconciliationRequired,
                Some(&detail),
            )
            .await?;
            finish(
                context.broker,
                context.bus,
                context.organization_id,
                context.job_id,
                EVENT_ROTATION_FAILED,
                context.project_id,
                None,
            )
            .await?;
            return Err(error);
        }
    }
    for to in [
        RotationState::DependentsUpdated,
        RotationState::Observing,
        RotationState::PreviousRevoked,
        RotationState::RevocationVerified,
        RotationState::Completed,
    ] {
        advance(context.broker, context.job_id, state, to, None).await?;
    }
    finish(
        context.broker,
        context.bus,
        context.organization_id,
        context.job_id,
        EVENT_ROTATION_SUCCEEDED,
        context.project_id,
        Some(credential_version_hint(view)),
    )
    .await
}

/// Execute a pending connection rotation via broker refresh, driving the
/// `opensesame-rotation` machine and persisting every transition.
///
/// Candidate = [`ConnectionBroker::refresh`] (the provider mints a new token
/// generation and the broker CAS-activates it). No provider in the catalog
/// exposes a no-op verification invoke, so `CandidateVerified` records
/// `verify_skipped` in the job detail rather than fabricating a verify. The
/// OAuth refresh grant invalidates the previous token server-side, which is
/// what `PreviousRevoked → RevocationVerified` records — the broker never
/// deletes a credential row on this path. On refresh failure the machine walks
/// `RollbackStarted → RollbackCompleted`: the previous credential still stands
/// (or the broker already marked the connection `needs_reauth` itself) and the
/// job keeps the error hint, truncated, never token material.
///
/// # Errors
///
/// Returns an error when the job, connection, state transition, refresh, or dependent update fails.
pub async fn execute_connection_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    let job = load_scheduled_job(broker, organization_id, job_id).await?;
    let connection_id = match &job.target {
        RotationTarget::Connection { connection_id } => connection_id.clone(),
        RotationTarget::StorePath { .. } => {
            return Err(BrokerError::Invalid(
                "store-path rotation is executed by the sealed-store / CLI path, not the broker"
                    .into(),
            ));
        }
        RotationTarget::WebLogin { .. } => {
            return Err(BrokerError::Invalid(
                "web-login rotation is executed by the sandbox runner, not the connection path"
                    .into(),
            ));
        }
    };
    let org = organization_id.to_string();

    let mut state = RotationState::Scheduled;
    advance(broker, job_id, &mut state, RotationState::Discovering, None).await?;
    let discovered = broker.get_connection(organization_id, &connection_id).await;
    let project_id = discovered
        .as_ref()
        .ok()
        .and_then(|view| view.project_id.clone());

    let refreshed = match discovered {
        Ok(_) => broker.refresh(organization_id, &connection_id).await,
        Err(error) => Err(error),
    };

    match refreshed {
        Ok(view) => {
            complete_successful_rotation(
                SuccessfulRotation {
                    broker,
                    bus,
                    organization_id: &org,
                    job_id,
                    connection_id: &connection_id,
                    project_id: project_id.as_deref(),
                },
                &mut state,
                &view,
            )
            .await
        }
        Err(error) => {
            let detail = truncate_detail(&error.hint());
            for (to, note) in [
                (RotationState::CandidateGenerated, None),
                (RotationState::CandidateInstalled, None),
                (RotationState::RollbackStarted, Some(detail.as_str())),
                (RotationState::RollbackCompleted, None),
            ] {
                advance(broker, job_id, &mut state, to, note).await?;
            }
            let _ = finish(
                broker,
                bus,
                &org,
                job_id,
                EVENT_ROTATION_FAILED,
                project_id.as_deref(),
                None,
            )
            .await?;
            Err(error)
        }
    }
}

/// One legal machine transition, persisted. An illegal transition is a
/// programming error and fails the job loudly rather than lying in the table.
async fn advance(
    broker: &ConnectionBroker,
    job_id: &str,
    state: &mut RotationState,
    to: RotationState,
    detail: Option<&str>,
) -> Result<()> {
    *state = state.transition(to).map_err(|_| {
        BrokerError::Invalid(format!(
            "illegal rotation transition {} -> {}",
            state_name(*state),
            state_name(to)
        ))
    })?;
    store::update_rotation_job_state(&broker.pool, job_id, state_name(*state), detail).await
}

async fn finish(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    organization_id: &str,
    job_id: &str,
    event_type: &str,
    project_id: Option<&str>,
    version_id: Option<String>,
) -> Result<RotationJob> {
    let job = broker
        .get_rotation_job(organization_id, job_id)
        .await?
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{job_id}` not found")))?;
    record_rotation_changelog(broker, event_type, &job, project_id, version_id).await;
    let _ = bus
        .publish(bus_event(event_type, job_event_data(&job)))
        .await;
    Ok(job)
}

/// Drain bus messages and execute rotations that were requested.
///
/// # Errors
///
/// Returns an error when bus events cannot be drained.
pub async fn consume_rotation_events(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    max: usize,
) -> anyhow::Result<Vec<RotationJob>> {
    let events = bus.drain(max).await?;
    let mut completed = Vec::new();
    for event in events {
        if event.r#type != EVENT_ROTATION_REQUESTED {
            continue;
        }
        let Some(job_id) = event.data.get("rotation_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(org) = event
            .data
            .get("organization_id")
            .and_then(Value::as_str)
            .and_then(|s| OrganizationId::parse(s).ok())
        else {
            continue;
        };
        match execute_rotation(broker, bus, &org, job_id).await {
            Ok(job) => completed.push(job),
            Err(error) => {
                tracing::warn!(rotation_id = %job_id, error = %error.hint(), "rotation consume failed");
                if let Ok(Some(job)) = broker.get_rotation_job(&org.to_string(), job_id).await {
                    completed.push(job);
                }
            }
        }
    }
    Ok(completed)
}

/// Prefer an opaque version marker from the view without reading sealed bytes.
fn credential_version_hint(view: &ConnectionView) -> String {
    // ConnectionView does not expose credential version directly; use
    // last_refreshed_at + updated_at as a non-secret generation fingerprint.
    match (
        view.last_refreshed_at.as_deref(),
        view.updated_at.as_str(),
        view.refreshable,
    ) {
        (Some(refreshed), updated, _) => format!("v:{refreshed}:{updated}"),
        (None, updated, true) => format!("v:none:{updated}"),
        (None, updated, false) => format!("v:static:{updated}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use opensesame_storage::Db;
    use opensesame_task_bus::{BusEvent, InMemoryTaskBus};

    use crate::config::{BrokerConfig, ProviderConfig};
    use crate::model::CreateConnection;

    const KEY: [u8; 32] = [7u8; 32];

    struct DownBus;

    #[async_trait]
    impl TaskBus for DownBus {
        async fn publish(&self, _event: BusEvent) -> anyhow::Result<()> {
            anyhow::bail!("nats down");
        }

        async fn drain(&self, _max: usize) -> anyhow::Result<Vec<BusEvent>> {
            Ok(vec![])
        }
    }

    fn policy_target() -> RotationTarget {
        RotationTarget::Connection {
            connection_id: "conn_test".into(),
        }
    }

    async fn unrefreshable_broker() -> (Db, ConnectionBroker) {
        let db = Db::connect_memory().await.expect("db");
        let mut config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787");
        config = config.with_provider(
            "mock",
            ProviderConfig {
                client_id: Some("mock-client".into()),
                client_secret: Some("mock-secret".into()),
                token_url: Some("http://127.0.0.1:1/token".into()),
                ..Default::default()
            },
        );
        let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
        (db, broker)
    }

    fn policy(interval_seconds: u64, enabled: bool) -> RotationPolicy {
        RotationPolicy {
            id: "rotpol_test".into(),
            organization_id: "org_test".into(),
            target: policy_target(),
            owner_subject: None,
            interval_seconds,
            last_rotated_at: None,
            enabled,
            attempts: 0,
            next_attempt_at: None,
            needs_attention: false,
            last_error: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        }
    }

    /// A minimal enabled policy row, ready to be claimed.
    async fn seed_policy(pool: &sqlx::SqlitePool, id: &str, interval_seconds: i64) {
        let now = Utc::now();
        let row = store::RotationPolicyRow {
            id: id.to_string(),
            organization_id: "org_claim".into(),
            target_kind: "store_path".into(),
            target_id: "Dev/claim".into(),
            owner_subject: None,
            interval_seconds,
            last_rotated_at: None,
            enabled: true,
            lease_until: None,
            attempts: 0,
            next_attempt_at: None,
            needs_attention: false,
            last_error: None,
            created_at: now,
            updated_at: now,
        };
        store::upsert_rotation_policy(pool, &row)
            .await
            .expect("seed");
    }

    /// Two processes racing one policy: exactly one may act. This is the
    /// lockout defect — concurrently rotating one credential twice.
    #[tokio::test]
    async fn only_one_caller_can_claim_a_policy() {
        let (db, broker) = unrefreshable_broker().await;
        seed_policy(db.pool(), "rotpol_race", 60).await;

        let (first, second) = tokio::join!(
            broker.claim_rotation_policy("rotpol_race", 600),
            broker.claim_rotation_policy("rotpol_race", 600)
        );
        let won = usize::from(first.unwrap()) + usize::from(second.unwrap());
        assert_eq!(won, 1, "exactly one caller may hold the lease");
    }

    /// An expired lease is reclaimable, so a process that crashed mid-rotation
    /// releases its policy by the clock rather than by a liveness check.
    #[tokio::test]
    async fn an_expired_lease_is_reclaimable() {
        let (db, broker) = unrefreshable_broker().await;
        seed_policy(db.pool(), "rotpol_expired", 60).await;

        assert!(broker
            .claim_rotation_policy("rotpol_expired", 0)
            .await
            .unwrap());
        // A zero-second lease is already expired when the next claim evaluates.
        assert!(
            broker
                .claim_rotation_policy("rotpol_expired", 600)
                .await
                .unwrap(),
            "an expired lease does not strand the policy"
        );
    }

    /// A parked policy stops being claimed but stays enabled, so an operator
    /// still sees it. Auto-disabling would hide a rotation that is not running.
    #[tokio::test]
    async fn parked_policies_are_not_claimed_but_stay_enabled() {
        let (db, broker) = unrefreshable_broker().await;
        let now = Utc::now();
        let row = store::RotationPolicyRow {
            id: "rotpol_parked".into(),
            organization_id: "org_parked".into(),
            target_kind: "store_path".into(),
            target_id: "Dev/parked".into(),
            owner_subject: None,
            interval_seconds: 60,
            last_rotated_at: None,
            enabled: true,
            lease_until: None,
            attempts: 0,
            next_attempt_at: None,
            needs_attention: false,
            last_error: None,
            created_at: now,
            updated_at: now,
        };
        store::upsert_rotation_policy(db.pool(), &row)
            .await
            .expect("seed");

        assert!(broker
            .claim_rotation_policy("rotpol_parked", 0)
            .await
            .unwrap());

        // Park it: no next attempt, needs attention.
        broker
            .release_rotation_policy_failure("rotpol_parked", None, "provider unreachable")
            .await
            .expect("park");

        assert!(
            !broker
                .claim_rotation_policy("rotpol_parked", 600)
                .await
                .unwrap(),
            "a parked policy is not claimed"
        );
        let parked = store::get_rotation_policy(db.pool(), "rotpol_parked")
            .await
            .unwrap()
            .expect("row");
        assert!(parked.enabled, "parked is not disabled");
        assert!(parked.needs_attention);
        assert_eq!(parked.attempts, 1);
        assert_eq!(parked.last_error.as_deref(), Some("provider unreachable"));
    }

    /// Success releases the lease and schedules the next attempt one interval
    /// out, clearing any accumulated failure state.
    #[tokio::test]
    async fn success_release_clears_failure_state() {
        let (db, broker) = unrefreshable_broker().await;
        let now = Utc::now();
        let row = store::RotationPolicyRow {
            id: "rotpol_ok".into(),
            organization_id: "org_ok".into(),
            target_kind: "store_path".into(),
            target_id: "Dev/ok".into(),
            owner_subject: None,
            interval_seconds: 3600,
            last_rotated_at: None,
            enabled: true,
            lease_until: None,
            attempts: 2,
            next_attempt_at: None,
            needs_attention: false,
            last_error: Some("earlier failure".into()),
            created_at: now,
            updated_at: now,
        };
        store::upsert_rotation_policy(db.pool(), &row)
            .await
            .expect("seed");
        assert!(broker.claim_rotation_policy("rotpol_ok", 0).await.unwrap());
        let claimed = store::get_rotation_policy(db.pool(), "rotpol_ok")
            .await
            .unwrap()
            .and_then(RotationPolicy::from_row)
            .expect("policy");

        broker
            .release_rotation_policy_success(&claimed, now)
            .await
            .expect("release");

        let after = store::get_rotation_policy(db.pool(), "rotpol_ok")
            .await
            .unwrap()
            .expect("row");
        assert_eq!(after.attempts, 0);
        assert!(after.last_error.is_none());
        assert!(after.lease_until.is_none());
        assert!(after.next_attempt_at.is_some(), "next attempt is scheduled");
        assert!(!after.needs_attention);
        assert!(
            !broker
                .claim_rotation_policy("rotpol_ok", 600)
                .await
                .unwrap(),
            "the freshly scheduled next attempt holds the policy off"
        );
    }

    /// A database whose `rotation_policies` predates ADR 0076 must upgrade in
    /// place and keep working. The table is created lazily rather than by an
    /// early migration, so both the migration and `ensure_rotation_schema` have
    /// to converge on the same shape.
    #[tokio::test]
    async fn a_pre_lease_rotation_table_upgrades_in_place() {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool();

        // Recreate the pre-0073 shape, then seed a row through it.
        sqlx::query("DROP TABLE IF EXISTS rotation_policies")
            .execute(pool)
            .await
            .expect("drop");
        sqlx::query(
            "CREATE TABLE rotation_policies (
                id TEXT PRIMARY KEY,
                organization_id TEXT NOT NULL,
                target_kind TEXT NOT NULL CHECK (target_kind IN ('connection','store_path')),
                target_id TEXT NOT NULL,
                interval_seconds INTEGER NOT NULL,
                last_rotated_at TEXT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             )",
        )
        .execute(pool)
        .await
        .expect("legacy table");
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO rotation_policies (id, organization_id, target_kind, target_id, \
             interval_seconds, last_rotated_at, enabled, created_at, updated_at) \
             VALUES ('rotpol_legacy', 'org_legacy', 'store_path', 'Dev/legacy', 60, NULL, 1, ?, ?)",
        )
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .expect("legacy row");

        // The upgrade is idempotent and additive.
        store::ensure_rotation_schema(pool).await.expect("upgrade");
        store::ensure_rotation_schema(pool)
            .await
            .expect("upgrade is idempotent");

        let upgraded = store::get_rotation_policy(pool, "rotpol_legacy")
            .await
            .expect("read")
            .expect("row survived");
        assert_eq!(upgraded.attempts, 0);
        assert!(upgraded.lease_until.is_none());
        assert!(!upgraded.needs_attention);
        assert_eq!(upgraded.target_id, "Dev/legacy", "existing data is intact");

        // And the legacy row is claimable through the new path.
        assert!(
            store::claim_rotation_policy(pool, "rotpol_legacy", 600)
                .await
                .expect("claim"),
            "an upgraded legacy policy can be leased"
        );
    }

    #[test]
    fn interval_parsing() {
        assert_eq!(parse_interval("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_interval("2h"), Some(Duration::from_secs(7200)));
        assert_eq!(parse_interval("90"), Some(Duration::from_secs(90)));
        assert_eq!(parse_interval("1d"), Some(Duration::from_secs(86_400)));
        assert_eq!(parse_interval("soon"), None);
        assert_eq!(parse_interval(""), None);
    }

    #[test]
    fn policy_due_math_covers_all_cases() {
        let now = Utc::now();
        // Disabled: never due.
        assert!(!policy_due_at(&policy(60, false), None, now));
        // Never rotated: due immediately.
        assert!(policy_due_at(&policy(60, true), None, now));
        // Last run long enough ago: due.
        assert!(policy_due_at(
            &policy(60, true),
            Some(now - chrono::Duration::seconds(61)),
            now
        ));
        // Last run too recent: not due.
        assert!(!policy_due_at(
            &policy(60, true),
            Some(now - chrono::Duration::seconds(30)),
            now
        ));
    }

    #[test]
    fn public_view_has_no_secret_fields() {
        let job = RotationJob {
            id: "rot_1".into(),
            policy_id: None,
            organization_id: "org_1".into(),
            target: policy_target(),
            state: "completed".into(),
            status: RotationStatus::Succeeded,
            detail: Some(VERIFY_SKIPPED_DETAIL.into()),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let view = job.public_view();
        let text = view.to_string();
        assert!(!text.contains("access_token"));
        assert!(!text.contains("\"secret\""));
        assert_eq!(view["status"], "succeeded");
        assert_eq!(view["state"], "completed");
    }

    #[test]
    fn status_derives_from_persisted_state() {
        assert_eq!(
            RotationStatus::from_state("completed"),
            RotationStatus::Succeeded
        );
        for failed in [
            "rollback_completed",
            "rollback_failed",
            "reconciliation_required",
        ] {
            assert_eq!(RotationStatus::from_state(failed), RotationStatus::Failed);
        }
        for pending in [
            "scheduled",
            "discovering",
            "candidate_verified",
            "observing",
        ] {
            assert_eq!(
                RotationStatus::from_state(pending),
                RotationStatus::Requested
            );
        }
    }

    #[test]
    fn event_type_constants_match_frozen_names() {
        assert_eq!(EVENT_ROTATION_REQUESTED, "credential.rotation.requested");
        assert_eq!(EVENT_ROTATION_SUCCEEDED, "credential.rotation.succeeded");
        assert_eq!(EVENT_ROTATION_FAILED, "credential.rotation.failed");
    }

    #[test]
    fn request_inserts_before_publish() {
        let src = include_str!("rotation.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        let request = production
            .find("pub async fn request_rotation")
            .expect("fn");
        let insert = production[request..]
            .find("insert_rotation_job")
            .expect("insert");
        let publish = production[request..].find("bus.publish").expect("publish");
        assert!(insert < publish, "job must be durable before the bus write");
    }

    #[tokio::test]
    async fn request_emits_requested_event_and_changelog_without_secrets() {
        let (_db, broker) = unrefreshable_broker().await;
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &broker,
            &bus,
            policy_target(),
            Some("proj_1".into()),
            "org_1",
            None,
        )
        .await
        .unwrap();
        assert_eq!(job.state, "scheduled");
        assert_eq!(job.status, RotationStatus::Requested);

        let events = bus.drain(10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, EVENT_ROTATION_REQUESTED);
        let payload = events[0].data.to_string();
        assert!(payload.contains(&job.id));
        assert!(!payload.contains("access_token"));
        assert!(!payload.contains("refresh_token"));
        assert!(!payload.contains("\"password\""));

        let changelog = broker
            .list_changelog("org_1", "proj_1", 10, None)
            .await
            .unwrap();
        assert_eq!(changelog.len(), 1);
        assert_eq!(changelog[0].event_type, EVENT_ROTATION_REQUESTED);
    }

    #[tokio::test]
    async fn request_keeps_the_job_when_the_bus_is_partitioned() {
        let (_db, broker) = unrefreshable_broker().await;
        let err = request_rotation(
            &broker,
            &DownBus,
            policy_target(),
            Some("proj_1".into()),
            "org_1",
            None,
        )
        .await;
        assert!(err.is_err(), "partition must surface to the caller");
        let jobs = broker.list_rotation_jobs("org_1", 10).await.unwrap();
        assert_eq!(jobs.len(), 1, "durable job must survive bus partition");
        assert_eq!(jobs[0].state, "scheduled");
        assert!(!jobs[0].public_view().to_string().contains("access_token"));
    }

    #[tokio::test]
    async fn refresh_failure_walks_rollback_states_and_keeps_a_bounded_hint() {
        let (_db, broker) = unrefreshable_broker().await;
        let org = OrganizationId::from_uuid(uuid::Uuid::nil());
        let created = broker
            .create_connection(
                &org,
                CreateConnection {
                    provider_id: "mock".into(),
                    integration_id: None,
                    owner_subject: None,
                    display_name: None,
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .expect("create");

        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &broker,
            &bus,
            RotationTarget::Connection {
                connection_id: created.connection_id.clone(),
            },
            None,
            &org.to_string(),
            None,
        )
        .await
        .unwrap();
        let _ = bus.drain(10).await.unwrap();

        execute_connection_rotation(&broker, &bus, &org, &job.id)
            .await
            .expect_err("pending connection is not refreshable");

        let events = bus.drain(10).await.unwrap();
        assert!(events.iter().any(|e| e.r#type == EVENT_ROTATION_FAILED));
        let failed = broker
            .get_rotation_job(&org.to_string(), &job.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(failed.state, "rollback_completed");
        assert_eq!(failed.status, RotationStatus::Failed);
        let detail = failed.detail.as_deref().unwrap_or_default();
        assert!(!detail.is_empty(), "rollback records the error hint");
        assert!(detail.chars().count() <= MAX_DETAIL_CHARS);
        let text = failed.public_view().to_string();
        assert!(!text.contains("access_token"));

        // Terminal jobs never re-execute.
        let err = execute_connection_rotation(&broker, &bus, &org, &job.id)
            .await
            .expect_err("terminal job must not restart");
        assert!(err.hint().contains("already"));
    }

    #[tokio::test]
    async fn store_path_target_parks_in_reconciliation_required() {
        let (_db, broker) = unrefreshable_broker().await;
        let org = OrganizationId::from_uuid(uuid::Uuid::nil());
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &broker,
            &bus,
            RotationTarget::StorePath {
                path: "Dev/api-token".into(),
            },
            Some("proj_1".into()),
            &org.to_string(),
            None,
        )
        .await
        .unwrap();
        let _ = bus.drain(10).await.unwrap();

        let parked = execute_rotation(&broker, &bus, &org, &job.id)
            .await
            .unwrap();
        assert_eq!(parked.state, "reconciliation_required");
        assert_eq!(parked.status, RotationStatus::Failed);
        assert_eq!(parked.detail.as_deref(), Some(STORE_PATH_DEFERRAL_DETAIL));
        let events = bus.drain(10).await.unwrap();
        assert!(events.iter().any(|e| e.r#type == EVENT_ROTATION_FAILED));
    }

    #[tokio::test]
    async fn policies_and_jobs_survive_a_broker_restart_over_the_same_pool() {
        let db = Db::connect_memory().await.expect("db");
        let config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787");
        let broker = ConnectionBroker::new(db.pool().clone(), config.clone()).expect("broker");

        let policy = broker
            .upsert_rotation_policy(
                "org_restart",
                UpsertRotationPolicy {
                    id: None,
                    target: policy_target(),
                    owner_subject: None,
                    interval_seconds: 3600,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &broker,
            &bus,
            policy_target(),
            None,
            "org_restart",
            Some(policy.id.clone()),
        )
        .await
        .unwrap();
        drop(broker);

        // A fresh broker over the same pool sees the durable rows.
        let reborn = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
        let policies = reborn.list_rotation_policies("org_restart").await.unwrap();
        assert_eq!(policies.len(), 1);
        assert_eq!(policies[0].id, policy.id);
        assert_eq!(policies[0].interval_seconds, 3600);
        let restored = reborn
            .get_rotation_job("org_restart", &job.id)
            .await
            .unwrap()
            .expect("job survives restart");
        assert_eq!(restored.state, "scheduled");
        assert_eq!(restored.policy_id.as_deref(), Some(policy.id.as_str()));
        // Cross-tenant reads see nothing.
        assert!(reborn
            .get_rotation_job("org_other", &job.id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn policy_upsert_is_tenant_scoped_and_keeps_last_rotated() {
        let (_db, broker) = unrefreshable_broker().await;
        let policy = broker
            .upsert_rotation_policy(
                "org_a",
                UpsertRotationPolicy {
                    id: None,
                    target: policy_target(),
                    owner_subject: None,
                    interval_seconds: 60,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        let rotated_at = Utc::now();
        broker
            .set_policy_last_rotated(&policy.id, rotated_at)
            .await
            .unwrap();

        // Update keeps last_rotated_at.
        let updated = broker
            .upsert_rotation_policy(
                "org_a",
                UpsertRotationPolicy {
                    id: Some(policy.id.clone()),
                    target: policy_target(),
                    owner_subject: None,
                    interval_seconds: 120,
                    enabled: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.interval_seconds, 120);
        assert!(!updated.enabled);
        assert!(updated.last_rotated_at.is_some());
        assert!(updated.last_rotated().is_some());

        // Another tenant cannot update it.
        let err = broker
            .upsert_rotation_policy(
                "org_b",
                UpsertRotationPolicy {
                    id: Some(policy.id.clone()),
                    target: policy_target(),
                    owner_subject: None,
                    interval_seconds: 60,
                    enabled: true,
                },
            )
            .await
            .expect_err("cross-tenant policy update must fail");
        assert!(err.hint().contains("not found"));

        // Disabled policies drop out of the scheduler read.
        assert!(broker
            .list_enabled_rotation_policies()
            .await
            .unwrap()
            .iter()
            .all(|p| p.id != policy.id));
    }
}
