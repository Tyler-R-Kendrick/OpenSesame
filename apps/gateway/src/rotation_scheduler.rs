//! Rotation scheduler (WP-9; leased per ADR 0073).
//!
//! A process-lifetime tick (default 60s, `OPENSESAME_ROTATION_TICK_SECONDS`)
//! that **claims** due rotation policies and executes each through the broker's
//! state machine. Emission of the frozen
//! `credential.rotation.requested|succeeded|failed` changelog rows happens
//! inside the broker's request/execute paths, so this loop stays a pure driver.
//!
//! The claim is the point. The previous version listed every enabled policy and
//! executed each due one with no lease, so two gateway processes both executed
//! the same policy at the same time. For an OAuth refresh that is waste; for a
//! credential change it is a lockout. `claim_due_rotation_policies` grants one
//! winner per policy and leases it, mirroring the claim/lease sagas in
//! `backup.rs` and `sync_actor.rs`.
//!
//! Failure handling mirrors `sync_actor.rs` too: exponential backoff up to
//! `backoff_cap_seconds`, then **park** at `max_attempts` — the policy stops
//! retrying, stays `enabled`, and raises `needs_attention`. It is deliberately
//! not auto-disabled: a rotation policy that silently switches itself off is
//! the ADR 0052 §11 failure mode, where the operator believes credentials are
//! rotating and they are not.
//!
//! Value discipline: nothing this module stores or logs is credential material.
//! Park reasons are broker hints, truncated by the broker before they reach a
//! durable row.

use std::time::Duration;

use chrono::Utc;
use opensesame_connection_broker::{
    execute_rotation, request_rotation, ConnectionBroker, RotationJob, RotationPolicy,
};
use opensesame_domain::OrganizationId;
use opensesame_task_bus::TaskBus;

use crate::app_state::AppState;

const DEFAULT_TICK_SECONDS: u64 = 60;

/// Knobs for one scheduler instance. Tests inject a zero backoff; production
/// uses `Default`. Shaped after [`crate::sync_actor::SyncActorConfig`].
#[derive(Clone, Copy, Debug)]
pub struct RotationSchedulerConfig {
    /// Policies claimed per pass.
    pub batch_limit: i64,
    /// Lease held while a policy executes. Longer than the sync actor's because
    /// a rotation talks to a provider; a crashed process releases by the clock.
    pub lease_seconds: i64,
    /// First backoff delay; doubles per attempt up to `backoff_cap_seconds`.
    pub backoff_base_seconds: i64,
    pub backoff_cap_seconds: i64,
    /// Consecutive failures before the policy parks for operator attention.
    pub max_attempts: i64,
}

impl Default for RotationSchedulerConfig {
    fn default() -> Self {
        Self {
            batch_limit: 16,
            lease_seconds: 120,
            backoff_base_seconds: 60,
            backoff_cap_seconds: 3600,
            max_attempts: 8,
        }
    }
}

fn tick_seconds() -> u64 {
    std::env::var("OPENSESAME_ROTATION_TICK_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs >= 1)
        .unwrap_or(DEFAULT_TICK_SECONDS)
}

/// Backoff for the `attempt`-th consecutive failure (1-based), capped.
#[must_use]
fn backoff_seconds(cfg: &RotationSchedulerConfig, attempt: i64) -> i64 {
    let shift = u32::try_from(attempt.saturating_sub(1).clamp(0, 32)).unwrap_or(0);
    cfg.backoff_base_seconds
        .saturating_mul(1i64 << shift.min(31))
        .min(cfg.backoff_cap_seconds)
}

/// Process-lifetime scheduler loop. Spawned from `main` beside the backup actor.
pub async fn run(state: AppState) {
    let cfg = RotationSchedulerConfig::default();
    let mut interval = tokio::time::interval(Duration::from_secs(tick_seconds()));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pass(&state, &cfg).await {
            Ok(0) => {}
            Ok(executed) => tracing::info!(executed, "rotation scheduler pass executed due jobs"),
            Err(error) => tracing::warn!(%error, "rotation scheduler pass failed"),
        }
    }
}

/// One scheduler pass: claim the due policies and execute each. Per-policy
/// failures are recorded on their jobs and their policy, and never abort the
/// rest of the pass. Public for tests.
pub async fn pass(state: &AppState, cfg: &RotationSchedulerConfig) -> anyhow::Result<usize> {
    let broker = state.connection_broker.as_ref();
    let claimed = broker
        .claim_due_rotation_policies(cfg.batch_limit, cfg.lease_seconds)
        .await?;
    let mut executed = 0usize;
    for policy in claimed {
        execute_claimed_policy(state, cfg, &policy).await;
        executed += 1;
    }
    Ok(executed)
}

/// Executes one claimed policy and releases its lease either way.
///
/// A policy is only claimed when it is due, so due-ness is not re-checked here:
/// the SQL predicate in `claim_due_rotation_policies` is the single authority,
/// and re-deciding it in Rust is how the two drift apart.
async fn execute_claimed_policy(
    state: &AppState,
    cfg: &RotationSchedulerConfig,
    policy: &RotationPolicy,
) {
    let broker = state.connection_broker.as_ref();
    let now = Utc::now();
    let Some(organization_id) = eligible_organization(policy) else {
        release_failure(
            state,
            cfg,
            policy,
            now,
            "policy has a non-canonical organization id",
        )
        .await;
        return;
    };

    let bus = state.task_bus.read().await;
    let outcome = match request_policy_rotation(broker, bus.as_ref(), policy).await {
        Ok(job) => execute_rotation(broker, bus.as_ref(), &organization_id, &job.id)
            .await
            .map(|_| ()),
        Err(error) => Err(error),
    };
    drop(bus);

    match outcome {
        // `Ok` covers the honest store-path deferral, which parks its *job* in
        // `reconciliation_required` by design (the sealed-store CLI owns that
        // path). That is the designed outcome of a healthy pass, not a failure
        // to back off from — the parked job is the operator-visible signal.
        Ok(()) => {
            if let Err(error) = broker.release_rotation_policy_success(policy, now).await {
                tracing::warn!(policy_id = %policy.id, error = %error.hint(),
                    "failed to release rotation policy after success");
            }
        }
        Err(error) => {
            tracing::warn!(
                policy_id = %policy.id,
                error = %error.hint(),
                "rotation execution failed"
            );
            release_failure(state, cfg, policy, now, &error.hint()).await;
        }
    }
}

/// Backs the policy off, or parks it once `max_attempts` consecutive failures
/// have accumulated. Parked means: stop retrying, stay enabled, raise
/// `needs_attention`.
async fn release_failure(
    state: &AppState,
    cfg: &RotationSchedulerConfig,
    policy: &RotationPolicy,
    now: chrono::DateTime<Utc>,
    reason: &str,
) {
    // `policy.attempts` is the count before this failure.
    let attempt = policy.attempts.saturating_add(1);
    let next_attempt_at = if attempt >= cfg.max_attempts {
        None
    } else {
        Some(now + chrono::Duration::seconds(backoff_seconds(cfg, attempt)))
    };
    if let Err(error) = state
        .connection_broker
        .release_rotation_policy_failure(&policy.id, next_attempt_at, reason)
        .await
    {
        tracing::warn!(policy_id = %policy.id, error = %error.hint(),
            "failed to release rotation policy after failure");
    }
}

fn eligible_organization(policy: &RotationPolicy) -> Option<OrganizationId> {
    OrganizationId::parse(&policy.organization_id).ok()
}

async fn request_policy_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    policy: &RotationPolicy,
) -> Result<RotationJob, opensesame_connection_broker::BrokerError> {
    let result = request_rotation(
        broker,
        bus,
        policy.target.clone(),
        None,
        &policy.organization_id,
        Some(policy.id.clone()),
    )
    .await;
    if let Err(error) = &result {
        tracing::warn!(policy_id = %policy.id, error = %error.hint(), "rotation request failed");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::test_demo_state;
    use opensesame_connection_broker::{RotationTarget, UpsertRotationPolicy};

    /// Zero backoff so failure tests do not depend on wall-clock waits.
    fn test_cfg() -> RotationSchedulerConfig {
        RotationSchedulerConfig {
            backoff_base_seconds: 0,
            backoff_cap_seconds: 0,
            max_attempts: 3,
            ..RotationSchedulerConfig::default()
        }
    }

    async fn store_path_policy(st: &AppState, path: &str, interval: u64, enabled: bool) -> String {
        let org = st.connection_organization.to_string();
        st.connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath { path: path.into() },
                    interval_seconds: interval,
                    enabled,
                },
            )
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn pass_executes_due_policies_and_advances_schedule() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        // A store-path policy is executable without any provider network: the
        // job parks in reconciliation_required (honest deferral).
        let policy_id = store_path_policy(&st, "Dev/api-token", 3600, true).await;

        assert_eq!(
            pass(&st, &test_cfg()).await.unwrap(),
            1,
            "never-rotated policy is due"
        );

        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].policy_id.as_deref(), Some(policy_id.as_str()));
        assert_eq!(jobs[0].state, "reconciliation_required");

        // The honest deferral is a healthy outcome: the policy is released as a
        // success, so it keeps its schedule instead of backing off.
        let policies = st
            .connection_broker
            .list_rotation_policies(&org)
            .await
            .unwrap();
        assert!(policies[0].last_rotated_at.is_some());
        assert!(policies[0].next_attempt_at.is_some());
        assert_eq!(policies[0].attempts, 0);
        assert!(!policies[0].needs_attention);

        assert_eq!(
            pass(&st, &test_cfg()).await.unwrap(),
            0,
            "not due until the interval elapses"
        );
        assert_eq!(
            st.connection_broker
                .list_rotation_jobs(&org, 10)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn disabled_policies_never_execute() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        store_path_policy(&st, "Dev/other", 60, false).await;
        assert_eq!(pass(&st, &test_cfg()).await.unwrap(), 0);
        assert!(st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap()
            .is_empty());
    }

    /// The defect this scheduler's lease exists to prevent: two gateway
    /// processes both executing the same due policy. Concurrently rotating one
    /// credential twice is how an account gets locked out.
    #[tokio::test]
    async fn concurrent_passes_execute_a_due_policy_once() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        store_path_policy(&st, "Dev/contended", 3600, true).await;

        let cfg = test_cfg();
        let (a, b) = tokio::join!(pass(&st, &cfg), pass(&st, &cfg));
        let total = a.unwrap() + b.unwrap();
        assert_eq!(total, 1, "exactly one pass may claim a due policy");

        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1, "one claim means one rotation job");
    }

    /// A leased policy is not claimable by another pass until the lease expires.
    #[tokio::test]
    async fn a_leased_policy_is_not_reclaimed() {
        let st = test_demo_state().await;
        store_path_policy(&st, "Dev/leased", 3600, true).await;
        let claimed = st
            .connection_broker
            .claim_due_rotation_policies(16, 600)
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        // The lease is held and never released, so the policy stays invisible.
        assert_eq!(pass(&st, &test_cfg()).await.unwrap(), 0);
    }

    /// Repeated failures back off and then park: still enabled, flagged for
    /// attention, no longer retrying. Auto-disabling instead would hide a
    /// rotation that is not happening.
    #[tokio::test]
    async fn repeated_failures_park_without_disabling() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        // A connection target naming a connection that does not exist fails in
        // the broker on every attempt.
        let policy_id = st
            .connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::Connection {
                        connection_id: "conn_does_not_exist".into(),
                    },
                    interval_seconds: 1,
                    enabled: true,
                },
            )
            .await
            .unwrap()
            .id;

        let cfg = test_cfg();
        for _ in 0..cfg.max_attempts {
            pass(&st, &cfg).await.unwrap();
        }

        let policy = st
            .connection_broker
            .list_rotation_policies(&org)
            .await
            .unwrap()
            .into_iter()
            .find(|p| p.id == policy_id)
            .expect("policy");
        assert!(policy.enabled, "a parked policy stays enabled and visible");
        assert!(policy.needs_attention, "parked policies are flagged");
        assert!(
            policy.next_attempt_at.is_none(),
            "parked means no next attempt"
        );
        assert!(policy.attempts >= cfg.max_attempts);
        assert!(policy.last_error.is_some(), "the operator gets a hint");

        // Parked policies are not claimed again.
        assert_eq!(pass(&st, &cfg).await.unwrap(), 0);

        // Re-saving the policy is a deliberate operator act and clears the park.
        st.connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: Some(policy_id.clone()),
                    target: RotationTarget::StorePath {
                        path: "Dev/fixed".into(),
                    },
                    interval_seconds: 3600,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(pass(&st, &cfg).await.unwrap(), 1, "re-saving un-parks");
    }

    #[test]
    fn backoff_doubles_then_caps() {
        let cfg = RotationSchedulerConfig {
            backoff_base_seconds: 60,
            backoff_cap_seconds: 600,
            ..RotationSchedulerConfig::default()
        };
        assert_eq!(backoff_seconds(&cfg, 1), 60);
        assert_eq!(backoff_seconds(&cfg, 2), 120);
        assert_eq!(backoff_seconds(&cfg, 4), 480);
        assert_eq!(backoff_seconds(&cfg, 5), 600, "capped");
        assert_eq!(
            backoff_seconds(&cfg, 64),
            600,
            "no overflow at large attempts"
        );
    }
}
