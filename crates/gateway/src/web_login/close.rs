//! Closing a run durably, before its rotation is settled (ADR 0159).
//!
//! Closing is what makes a run's step queue refuse everything: once
//! `closed_at` is set no step can be claimed and no outcome stored. A run that
//! stops waiting while its driver still holds a claim depends on it — the
//! driver's late answer is only kept out of the queue by the close. So the
//! close is not a courtesy to log and forget: until it has landed, the
//! rotation is neither settled nor released, because a settlement says "this
//! run is over" and a still-open run is not.
//!
//! [`WebLoginLauncher::close`] tries a bounded number of times with doubling
//! backoff and **verifies** by reading the run back (a successful `UPDATE` of
//! zero rows is not proof the run is closed). When it cannot, the job is
//! parked for reconciliation with a detail that says so, and the run is left
//! to the reaper (`reaper`), which closes whatever has outlived the horizon.

use std::time::Duration;

use chrono::Utc;
use opensesame_connection_broker::rotation::web_login::WebLoginSettlement;

use super::prepare::Plan;
use super::settle::unclosed;
use super::WebLoginLauncher;

/// How hard a run is closed before giving up.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CloseRetry {
    /// Attempts in all, the first included. At least one is always made.
    pub attempts: u32,
    /// The wait after the first failed attempt; each later wait doubles, up to
    /// [`MAX_BACKOFF`].
    pub backoff: Duration,
}

/// No single wait is longer than this.
const MAX_BACKOFF: Duration = Duration::from_secs(4);

impl Default for CloseRetry {
    fn default() -> Self {
        Self {
            attempts: 5,
            backoff: Duration::from_millis(250),
        }
    }
}

impl CloseRetry {
    fn wait_after(self, failed_attempts: u32) -> Duration {
        let doublings = failed_attempts.saturating_sub(1).min(16);
        self.backoff.saturating_mul(1 << doublings).min(MAX_BACKOFF)
    }
}

impl WebLoginLauncher {
    /// Close the run: its steps can no longer be claimed, and a person reading
    /// it sees why it stopped. Returns the settlement to record — the one the
    /// run reached when the close landed, and a reconciliation that says the
    /// run could not be closed when it did not.
    pub(super) async fn close(
        &self,
        plan: &Plan,
        run_id: &str,
        settlement: WebLoginSettlement,
    ) -> WebLoginSettlement {
        self.record_why(plan, run_id, &settlement).await;
        let retry = self.close_retry;
        for attempt in 1..=retry.attempts.max(1) {
            if self.closed(plan, run_id).await {
                return settlement;
            }
            if attempt < retry.attempts {
                tokio::time::sleep(retry.wait_after(attempt)).await;
            }
        }
        tracing::error!(
            %run_id,
            attempts = retry.attempts.max(1),
            "a web-login run could not be closed; its job is parked for reconciliation",
        );
        unclosed(settlement)
    }

    /// Best effort: the reason the run stopped, on the run. Losing a version
    /// race to a person who took the page is not an error, and a database that
    /// is failing is found out by the close itself.
    async fn record_why(&self, plan: &Plan, run_id: &str, settlement: &WebLoginSettlement) {
        let db = &self.state.db;
        let org = plan.organization_id.to_string();
        let reason = match settlement {
            WebLoginSettlement::Completed => None,
            WebLoginSettlement::NotSubmitted(detail) | WebLoginSettlement::Reconcile(detail) => {
                Some(detail.clone())
            }
        };
        let Ok(Some(run)) = db.get_observation_run(&org, run_id).await else {
            return;
        };
        let update = opensesame_storage::ObservationControlUpdate {
            run_id: run.id.clone(),
            organization_id: org,
            expected_version: run.version,
            control_state: run.control_state.clone(),
            // The span is over with the run, whatever it ended on.
            quiescence: "quiescent".into(),
            handoff_queued: false,
            lease_holder: run.lease_holder.clone(),
            lease_expires_at: run.lease_expires_at.clone(),
            blocked_reason: reason,
        };
        if let Err(error) = db
            .update_observation_control(&update, &Utc::now().to_rfc3339())
            .await
        {
            tracing::warn!(%error, %run_id, "why a web-login run stopped could not be recorded");
        }
    }

    /// One close attempt, and whether the run is closed afterwards: written,
    /// then read back. A run that is gone (purged) is closed.
    async fn closed(&self, plan: &Plan, run_id: &str) -> bool {
        let db = &self.state.db;
        let org = plan.organization_id.to_string();
        if let Err(error) = db
            .close_observation_run(&org, run_id, &Utc::now().to_rfc3339())
            .await
        {
            tracing::warn!(%error, %run_id, "web-login run could not be closed");
            return false;
        }
        match db.get_observation_run(&org, run_id).await {
            Ok(Some(run)) => run.closed_at.is_some(),
            Ok(None) => true,
            Err(error) => {
                tracing::warn!(%error, %run_id, "a closed web-login run could not be read back");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_is_capped() {
        let retry = CloseRetry {
            attempts: 9,
            backoff: Duration::from_millis(500),
        };
        let waits: Vec<_> = (1..=6).map(|n| retry.wait_after(n).as_millis()).collect();
        assert_eq!(waits, [500, 1000, 2000, 4000, 4000, 4000]);
        assert_eq!(retry.wait_after(u32::MAX), MAX_BACKOFF);
    }
}
