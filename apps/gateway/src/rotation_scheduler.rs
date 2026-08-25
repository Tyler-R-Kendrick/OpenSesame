//! Rotation scheduler (WP-9).
//!
//! A process-lifetime tick (default 60s, `OPENSESAME_ROTATION_TICK_SECONDS`)
//! that lists enabled durable rotation policies, asks `policy_due_at` which
//! are due, and executes each due job through the broker's state machine.
//! Emission of the frozen `credential.rotation.requested|succeeded|failed`
//! changelog rows happens inside the broker's request/execute paths, so this
//! loop stays a pure driver. `last_rotated_at` advances after every attempt —
//! success or failure — so a broken target retries on its policy interval, not
//! on every tick (no silent retry-forever storm).

use std::time::Duration;

use chrono::Utc;
use opensesame_connection_broker::{
    execute_rotation, policy_due_at, request_rotation, ConnectionBroker, RotationJob,
    RotationPolicy,
};
use opensesame_domain::OrganizationId;
use opensesame_task_bus::TaskBus;

use crate::app_state::AppState;

const DEFAULT_TICK_SECONDS: u64 = 60;

fn tick_seconds() -> u64 {
    std::env::var("OPENSESAME_ROTATION_TICK_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs >= 1)
        .unwrap_or(DEFAULT_TICK_SECONDS)
}

/// Process-lifetime scheduler loop. Spawned from `main` beside the backup actor.
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(tick_seconds()));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pass(&state).await {
            Ok(0) => {}
            Ok(executed) => tracing::info!(executed, "rotation scheduler pass executed due jobs"),
            Err(error) => tracing::warn!(%error, "rotation scheduler pass failed"),
        }
    }
}

/// One scheduler pass: execute every due policy. Per-policy failures are
/// recorded on their jobs and never abort the rest of the pass.
pub async fn pass(state: &AppState) -> anyhow::Result<usize> {
    let broker = state.connection_broker.as_ref();
    let now = Utc::now();
    let policies = broker.list_enabled_rotation_policies().await?;
    let mut executed = 0usize;
    for policy in policies {
        if execute_due_policy(state, &policy, now).await {
            executed += 1;
        }
    }
    Ok(executed)
}

async fn execute_due_policy(
    state: &AppState,
    policy: &RotationPolicy,
    now: chrono::DateTime<Utc>,
) -> bool {
    let Some(organization_id) = eligible_organization(policy, now) else {
        return false;
    };
    let broker = state.connection_broker.as_ref();
    let bus = state.task_bus.read().await;
    let Some(job) = request_policy_rotation(broker, bus.as_ref(), policy).await else {
        return false;
    };
    if let Err(error) = execute_rotation(broker, bus.as_ref(), &organization_id, &job.id).await {
        // The failure is already persisted on the job and in the changelog.
        tracing::warn!(
            policy_id = %policy.id,
            rotation_id = %job.id,
            error = %error.hint(),
            "rotation execution failed"
        );
    }
    drop(bus);
    // Attempted counts as rotated for scheduling: retry on the policy's
    // interval, not on every tick.
    if let Err(error) = broker.set_policy_last_rotated(&policy.id, now).await {
        tracing::warn!(policy_id = %policy.id, error = %error.hint(), "failed to advance last_rotated_at");
    }
    true
}

fn eligible_organization(
    policy: &RotationPolicy,
    now: chrono::DateTime<Utc>,
) -> Option<OrganizationId> {
    if !policy_due_at(policy, policy.last_rotated(), now) {
        return None;
    }
    if let Ok(organization_id) = OrganizationId::parse(&policy.organization_id) {
        return Some(organization_id);
    }
    tracing::warn!(policy_id = %policy.id, "rotation policy has a non-canonical organization id; skipping");
    None
}
async fn request_policy_rotation(
    broker: &ConnectionBroker,
    bus: &dyn TaskBus,
    policy: &RotationPolicy,
) -> Option<RotationJob> {
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
    result.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::test_demo_state;
    use opensesame_connection_broker::{RotationTarget, UpsertRotationPolicy};

    #[tokio::test]
    async fn pass_executes_due_policies_and_advances_last_rotated() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        // A store-path policy is executable without any provider network: the
        // job parks in reconciliation_required (honest deferral).
        let policy = st
            .connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath {
                        path: "Dev/api-token".into(),
                    },
                    interval_seconds: 3600,
                    enabled: true,
                },
            )
            .await
            .unwrap();

        assert_eq!(pass(&st).await.unwrap(), 1, "never-rotated policy is due");

        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].policy_id.as_deref(), Some(policy.id.as_str()));
        assert_eq!(jobs[0].state, "reconciliation_required");

        // last_rotated_at advanced, so the policy is no longer due this tick.
        let policies = st
            .connection_broker
            .list_rotation_policies(&org)
            .await
            .unwrap();
        assert!(policies[0].last_rotated_at.is_some());
        assert_eq!(
            pass(&st).await.unwrap(),
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
        st.connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath {
                        path: "Dev/other".into(),
                    },
                    interval_seconds: 60,
                    enabled: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(pass(&st).await.unwrap(), 0);
        assert!(st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap()
            .is_empty());
    }
}
