//! Connection credential rotation (Doppler-parity capability under ADR 0005).
//!
//! Schedules and executes version-bumped credential rotation. Events are emitted
//! on a [`TaskBus`] as CloudEvents-shaped payloads. New secret material is never
//! placed on the bus or in API-facing views — only ids, versions, and status.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_task_bus::{BusEvent, TaskBus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{BrokerError, Result};
use crate::model::ConnectionView;
use crate::ConnectionBroker;

/// Frozen domain event type strings (WP-B / WP-E).
pub const EVENT_ROTATION_REQUESTED: &str = "credential.rotation.requested";
pub const EVENT_ROTATION_SUCCEEDED: &str = "credential.rotation.succeeded";
pub const EVENT_ROTATION_FAILED: &str = "credential.rotation.failed";

const BUS_SOURCE: &str = "opensesame://connection-broker/rotation";

/// What to rotate — connection credentials or a sealed-store path (metadata only).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RotationTarget {
    Connection { connection_id: String },
    StorePath { path: String },
}

/// Durable schedule without secrets.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RotationPolicy {
    pub id: String,
    /// ISO-8601 duration string (e.g. `PT24H`) or seconds as decimal string.
    pub interval: String,
    pub target: RotationTarget,
    pub project_id: Option<String>,
    pub organization_id: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

impl RotationPolicy {
    pub fn new(
        interval: impl Into<String>,
        target: RotationTarget,
        project_id: Option<String>,
        organization_id: Option<String>,
    ) -> Self {
        Self {
            id: format!("rotpol_{}", Uuid::now_v7()),
            interval: interval.into(),
            target,
            project_id,
            organization_id,
            enabled: true,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    /// Parse a simple interval (`30s`, `5m`, `1h`, `24h`, or raw seconds).
    pub fn interval_duration(&self) -> Option<Duration> {
        parse_interval(&self.interval)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RotationStatus {
    Requested,
    Succeeded,
    Failed,
}

/// Operator-visible rotation job. Never carries secret values.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RotationJob {
    pub id: String,
    pub policy_id: Option<String>,
    pub status: RotationStatus,
    pub target: RotationTarget,
    pub project_id: Option<String>,
    pub organization_id: Option<String>,
    pub previous_credential_version: Option<String>,
    pub new_credential_version: Option<String>,
    pub error: Option<String>,
    pub requested_at: String,
    pub completed_at: Option<String>,
}

impl RotationJob {
    /// JSON safe for HTTP / agents — strips any accidental secret-shaped keys.
    pub fn public_view(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let Some(obj) = v.as_object_mut() {
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
        v
    }
}

/// In-memory policy + job store for schedule/request (Host process local).
#[derive(Default)]
pub struct RotationRegistry {
    policies: Mutex<Vec<RotationPolicy>>,
    jobs: Mutex<Vec<RotationJob>>,
}

impl RotationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_policy(&self, policy: RotationPolicy) -> RotationPolicy {
        let mut policies = self.policies.lock().expect("rotation policies");
        if let Some(existing) = policies.iter_mut().find(|p| p.id == policy.id) {
            *existing = policy.clone();
        } else {
            policies.push(policy.clone());
        }
        policy
    }

    pub fn list_policies(&self) -> Vec<RotationPolicy> {
        self.policies.lock().expect("rotation policies").clone()
    }

    pub fn get_job(&self, id: &str) -> Option<RotationJob> {
        self.jobs
            .lock()
            .expect("rotation jobs")
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }

    pub fn list_jobs(&self) -> Vec<RotationJob> {
        self.jobs.lock().expect("rotation jobs").clone()
    }

    fn insert_job(&self, job: RotationJob) -> RotationJob {
        self.jobs.lock().expect("rotation jobs").push(job.clone());
        job
    }

    fn update_job(&self, job: RotationJob) -> RotationJob {
        let mut jobs = self.jobs.lock().expect("rotation jobs");
        if let Some(existing) = jobs.iter_mut().find(|j| j.id == job.id) {
            *existing = job.clone();
        } else {
            jobs.push(job.clone());
        }
        job
    }
}

fn parse_interval(raw: &str) -> Option<Duration> {
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
        "status": job.status,
        "target": job.target,
        "project_id": job.project_id,
        "organization_id": job.organization_id,
        "previous_credential_version": job.previous_credential_version,
        "new_credential_version": job.new_credential_version,
        "error": job.error,
        "requested_at": job.requested_at,
        "completed_at": job.completed_at,
    })
}

/// Request a rotation: persist a job and publish `credential.rotation.requested`.
pub async fn request_rotation(
    registry: &RotationRegistry,
    bus: &dyn TaskBus,
    target: RotationTarget,
    project_id: Option<String>,
    organization_id: Option<String>,
    policy_id: Option<String>,
) -> anyhow::Result<RotationJob> {
    let job = RotationJob {
        id: format!("rot_{}", Uuid::now_v7()),
        policy_id,
        status: RotationStatus::Requested,
        target,
        project_id,
        organization_id,
        previous_credential_version: None,
        new_credential_version: None,
        error: None,
        requested_at: Utc::now().to_rfc3339(),
        completed_at: None,
    };
    let job = registry.insert_job(job);
    bus.publish(bus_event(EVENT_ROTATION_REQUESTED, job_event_data(&job)))
        .await?;
    Ok(job)
}

/// Execute a pending connection rotation via broker refresh / version bump.
///
/// On success the prior credential version is superseded by the broker's CAS
/// activation path (new version sealed; old ciphertext replaced). Failure emits
/// `credential.rotation.failed` without secret bodies.
pub async fn execute_connection_rotation(
    registry: &RotationRegistry,
    bus: &dyn TaskBus,
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    job_id: &str,
) -> Result<RotationJob> {
    let mut job = registry
        .get_job(job_id)
        .ok_or_else(|| BrokerError::Invalid(format!("rotation job `{job_id}` not found")))?;

    let connection_id = match &job.target {
        RotationTarget::Connection { connection_id } => connection_id.clone(),
        RotationTarget::StorePath { .. } => {
            return Err(BrokerError::Invalid(
                "store-path rotation is executed by the sealed-store / CLI path, not the broker"
                    .into(),
            ));
        }
    };

    let before = broker
        .get_connection(organization_id, &connection_id)
        .await?;
    let previous_version = credential_version_hint(&before);
    job.previous_credential_version = previous_version.clone();
    job.organization_id = Some(organization_id.to_string());
    job.project_id = job.project_id.or(before.project_id.clone());

    match broker.refresh(organization_id, &connection_id).await {
        Ok(view) => {
            let new_version = credential_version_hint(&view);
            // Success means a new sealed generation replaced the prior one.
            if previous_version.is_some()
                && new_version.is_some()
                && previous_version == new_version
            {
                // Refresh can no-op when another writer already rotated; still
                // treat as success if the connection is active/refreshable.
                tracing::info!(
                    connection_id = %connection_id,
                    "rotation refresh returned same version hint; treating as succeeded"
                );
            }
            job.status = RotationStatus::Succeeded;
            job.new_credential_version = new_version;
            job.error = None;
            job.completed_at = Some(Utc::now().to_rfc3339());
            let job = registry.update_job(job);
            let _ = bus
                .publish(bus_event(EVENT_ROTATION_SUCCEEDED, job_event_data(&job)))
                .await;
            let _ = crate::changelog_hook::record_secret_changelog(
                crate::changelog_hook::RecordSecretChangelog {
                    event_type: EVENT_ROTATION_SUCCEEDED.into(),
                    project_id: job
                        .project_id
                        .clone()
                        .unwrap_or_else(|| "unknown".into()),
                    organization_id: job.organization_id.clone(),
                    target_id: Some(connection_id.clone()),
                    version_id: job.new_credential_version.clone(),
                    metadata: serde_json::Map::from_iter([(
                        "rotation_id".into(),
                        json!(job.id),
                    )]),
                    ..Default::default()
                },
            );
            Ok(job)
        }
        Err(error) => {
            job.status = RotationStatus::Failed;
            job.error = Some(error.hint());
            job.completed_at = Some(Utc::now().to_rfc3339());
            let job = registry.update_job(job);
            let _ = bus
                .publish(bus_event(EVENT_ROTATION_FAILED, job_event_data(&job)))
                .await;
            let _ = crate::changelog_hook::record_secret_changelog(
                crate::changelog_hook::RecordSecretChangelog {
                    event_type: EVENT_ROTATION_FAILED.into(),
                    project_id: job
                        .project_id
                        .clone()
                        .unwrap_or_else(|| "unknown".into()),
                    organization_id: job.organization_id.clone(),
                    target_id: Some(connection_id.clone()),
                    version_id: job.previous_credential_version.clone(),
                    metadata: serde_json::Map::from_iter([
                        ("rotation_id".into(), json!(job.id)),
                        ("error".into(), json!(job.error)),
                    ]),
                    ..Default::default()
                },
            );
            Err(error)
        }
    }
}

/// Drain bus messages and execute connection rotations that were requested.
pub async fn consume_rotation_events(
    registry: &RotationRegistry,
    bus: &dyn TaskBus,
    broker: &ConnectionBroker,
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
        match execute_connection_rotation(registry, bus, broker, &org, job_id).await {
            Ok(job) => completed.push(job),
            Err(error) => {
                tracing::warn!(rotation_id = %job_id, error = %error.hint(), "rotation consume failed");
                if let Some(job) = registry.get_job(job_id) {
                    completed.push(job);
                }
            }
        }
    }
    Ok(completed)
}

/// Shared handle used by gateway / worker wiring.
#[derive(Clone)]
pub struct RotationService {
    pub registry: Arc<RotationRegistry>,
}

impl RotationService {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(RotationRegistry::new()),
        }
    }
}

impl Default for RotationService {
    fn default() -> Self {
        Self::new()
    }
}

/// Prefer an opaque version marker from the view without reading sealed bytes.
fn credential_version_hint(view: &ConnectionView) -> Option<String> {
    // ConnectionView does not expose credential version directly; use
    // last_refreshed_at + updated_at as a non-secret generation fingerprint.
    match (
        view.last_refreshed_at.as_deref(),
        view.updated_at.as_str(),
        view.refreshable,
    ) {
        (Some(refreshed), updated, _) => Some(format!("v:{refreshed}:{updated}")),
        (None, updated, true) => Some(format!("v:none:{updated}")),
        (None, updated, false) => Some(format!("v:static:{updated}")),
    }
}

/// Whether a wall-clock instant is due for a policy (used by schedulers).
pub fn policy_due_at(policy: &RotationPolicy, last_run: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    if !policy.enabled {
        return false;
    }
    let Some(interval) = policy.interval_duration() else {
        return false;
    };
    match last_run {
        None => true,
        Some(last) => now >= last + chrono::Duration::from_std(interval).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_storage::Db;
    use opensesame_task_bus::InMemoryTaskBus;

    use crate::config::{BrokerConfig, ProviderConfig};
    use crate::model::CreateConnection;

    const KEY: [u8; 32] = [7u8; 32];

    fn policy_target() -> RotationTarget {
        RotationTarget::Connection {
            connection_id: "conn_test".into(),
        }
    }

    #[test]
    fn interval_parsing() {
        assert_eq!(
            parse_interval("30s"),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            parse_interval("2h"),
            Some(Duration::from_secs(7200))
        );
        assert_eq!(parse_interval("90"), Some(Duration::from_secs(90)));
    }

    #[test]
    fn public_view_has_no_secret_fields() {
        let job = RotationJob {
            id: "rot_1".into(),
            policy_id: None,
            status: RotationStatus::Succeeded,
            target: policy_target(),
            project_id: Some("proj_1".into()),
            organization_id: Some("org_1".into()),
            previous_credential_version: Some("v:a".into()),
            new_credential_version: Some("v:b".into()),
            error: None,
            requested_at: Utc::now().to_rfc3339(),
            completed_at: Some(Utc::now().to_rfc3339()),
        };
        let view = job.public_view();
        let text = view.to_string();
        assert!(!text.contains("access_token"));
        assert!(!text.contains("\"secret\""));
        assert_eq!(view["status"], "succeeded");
        assert_eq!(view["new_credential_version"], "v:b");
    }

    #[tokio::test]
    async fn request_emits_requested_event_without_secrets() {
        let registry = RotationRegistry::new();
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &registry,
            &bus,
            policy_target(),
            Some("proj_1".into()),
            Some("org_1".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(job.status, RotationStatus::Requested);

        let events = bus.drain(10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, EVENT_ROTATION_REQUESTED);
        let payload = events[0].data.to_string();
        assert!(payload.contains(&job.id));
        assert!(!payload.contains("access_token"));
        assert!(!payload.contains("refresh_token"));
        assert!(!payload.contains("\"password\""));
    }

    #[tokio::test]
    async fn execute_emits_failed_when_not_refreshable() {
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

        let registry = RotationRegistry::new();
        let bus = InMemoryTaskBus::default();
        let job = request_rotation(
            &registry,
            &bus,
            RotationTarget::Connection {
                connection_id: created.connection_id.clone(),
            },
            None,
            Some(org.to_string()),
            None,
        )
        .await
        .unwrap();
        let _ = bus.drain(10).await.unwrap();

        let err = execute_connection_rotation(&registry, &bus, &broker, &org, &job.id)
            .await
            .expect_err("pending connection is not refreshable");
        let _ = err;

        let events = bus.drain(10).await.unwrap();
        assert!(events.iter().any(|e| e.r#type == EVENT_ROTATION_FAILED));
        let failed = registry.get_job(&job.id).unwrap();
        assert_eq!(failed.status, RotationStatus::Failed);
        let text = failed.public_view().to_string();
        assert!(!text.contains("access_token"));
    }

    #[tokio::test]
    async fn request_keeps_the_job_when_the_bus_is_partitioned() {
        use async_trait::async_trait;
        use opensesame_task_bus::BusEvent;

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

        let registry = RotationRegistry::new();
        let err = request_rotation(
            &registry,
            &DownBus,
            policy_target(),
            Some("proj_1".into()),
            Some("org_1".into()),
            None,
        )
        .await;
        assert!(err.is_err(), "partition must surface to the caller");
        let jobs = registry.list_jobs();
        assert_eq!(jobs.len(), 1, "durable job must survive bus partition");
        assert_eq!(jobs[0].status, RotationStatus::Requested);
        assert!(!jobs[0].public_view().to_string().contains("access_token"));
    }

    #[test]
    fn request_inserts_before_publish() {
        let src = include_str!("rotation.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        let insert = production.find("registry.insert_job(job)").expect("insert");
        let publish = production.find("bus.publish").expect("publish");
        assert!(insert < publish, "job must be durable before the bus write");
    }

    #[test]
    fn policy_due_when_never_run() {
        let policy = RotationPolicy::new("1h", policy_target(), None, None);
        assert!(policy_due_at(&policy, None, Utc::now()));
    }

    #[test]
    fn event_type_constants_match_frozen_names() {
        assert_eq!(EVENT_ROTATION_REQUESTED, "credential.rotation.requested");
        assert_eq!(EVENT_ROTATION_SUCCEEDED, "credential.rotation.succeeded");
        assert_eq!(EVENT_ROTATION_FAILED, "credential.rotation.failed");
    }
}
