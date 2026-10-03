//! Retention: what the Host's own audit and run records are allowed to keep
//! (ADR 0076 §5, ADR 0081, ADR 0159).
//!
//! Two things grew without a caller that ever trimmed them:
//!
//! - the agent-hooks **decision audit** (`agent_hook_decisions`) — one row per
//!   verdict the intercept route answers, so it grows with agent traffic;
//! - **web-login runs** — `purge_expired_observation_runs` existed and nothing
//!   called it, so a run's row, its sealed log, its **step queue**
//!   (`runner_steps`) and its **hook records** (`agent_hook_records`) stayed
//!   for good.
//!
//! Each has a retention that is *stated*, not implied. A decision is kept for
//! [`DEFAULT_DECISION_RETENTION_DAYS`] days unless
//! `OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS` says otherwise; a run is
//! kept until the `expires_at` it was opened with (seven days), and everything
//! that hangs off it goes with it in one transaction.
//!
//! The actor runs a pass at startup and then hourly
//! (`OPENSESAME_RETENTION_TICK_SECONDS`). A pass that fails is logged and
//! retried on the next tick; nothing is retained *more* for having failed.

use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_storage::web_login_runs::retention::WebLoginPurge;

use crate::app_state::AppState;

/// How long a verdict's audit row is kept when the operator says nothing.
pub(crate) const DEFAULT_DECISION_RETENTION_DAYS: i64 = 90;
/// The longest an operator may ask for — ten years. A bound keeps a typo from
/// doing date arithmetic outside what a timestamp can hold.
const MAX_DECISION_RETENTION_DAYS: i64 = 3_650;

const DEFAULT_TICK_SECONDS: u64 = 3_600;

/// The decision audit's retention, in days.
///
/// `OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS` when it is an integer in
/// `1..=3650`; otherwise the default. An invalid value is ignored *loudly*:
/// retention that silently became "forever" or "nothing" would be a setting
/// the operator believed they had made.
pub(crate) fn decision_retention_days() -> i64 {
    parse_days(
        std::env::var("OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS")
            .ok()
            .as_deref(),
    )
}

fn parse_days(raw: Option<&str>) -> i64 {
    let Some(raw) = raw else {
        return DEFAULT_DECISION_RETENTION_DAYS;
    };
    match raw.trim().parse::<i64>() {
        Ok(days) if (1..=MAX_DECISION_RETENTION_DAYS).contains(&days) => days,
        _ => {
            tracing::warn!(
                value = raw,
                default = DEFAULT_DECISION_RETENTION_DAYS,
                "ignoring an agent-hook decision retention that is not 1 to 3650 days",
            );
            DEFAULT_DECISION_RETENTION_DAYS
        }
    }
}

fn tick() -> Duration {
    let seconds = std::env::var("OPENSESAME_RETENTION_TICK_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds >= 1)
        .unwrap_or(DEFAULT_TICK_SECONDS);
    Duration::from_secs(seconds)
}

/// What one pass removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PassReport {
    /// Agent-hooks decision rows.
    pub decisions: u64,
    /// Web-login runs, with their logs, steps and hook records.
    pub runs: WebLoginPurge,
}

/// One retention pass at `now`, keeping decisions for `decision_days`.
///
/// # Errors
///
/// The first failing purge. The other is still attempted, so one table's
/// trouble never keeps the other from being trimmed.
pub(crate) async fn pass(
    state: &AppState,
    now: DateTime<Utc>,
    decision_days: i64,
) -> anyhow::Result<PassReport> {
    let cutoff = now - chrono::Duration::days(decision_days);
    let decisions = state
        .db
        .purge_agent_hook_decisions(&cutoff.to_rfc3339())
        .await;
    let runs = state
        .db
        .purge_expired_web_login_runs(&now.to_rfc3339())
        .await;
    Ok(PassReport {
        decisions: decisions?,
        runs: runs?,
    })
}

/// The retention actor, for the process's lifetime. Its first pass is at
/// startup; the interval is read when the actor is built.
pub(crate) fn run(state: AppState) -> impl std::future::Future<Output = ()> {
    let period = tick();
    async move {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match pass(&state, Utc::now(), decision_retention_days()).await {
                Ok(report) if report == PassReport::default() => {}
                Ok(report) => tracing::info!(
                    decisions = report.decisions,
                    runs = report.runs.runs,
                    run_events = report.runs.events,
                    run_steps = report.runs.steps,
                    hook_records = report.runs.hook_records,
                    "retention removed expired audit and run records",
                ),
                Err(error) => {
                    tracing::warn!(%error, "a retention pass failed; it runs again next tick");
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
