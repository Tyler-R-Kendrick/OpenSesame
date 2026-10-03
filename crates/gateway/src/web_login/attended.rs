//! A run a person asked for (ADR 0076 §4).
//!
//! The lifecycle scanner starts unattended runs, and an unattended run needs a
//! recipe a real change has already proven. The first proof has to come from
//! somewhere, and it comes from here: an owner or admin who holds a recipe
//! signed by a pinned key asks for one run, drives it from their own browser,
//! and a completed run is recorded as the recipe's canary
//! ([`super::canary`]). It is the same run as the scanner's — the same job, the
//! same hooks, the same observation run — differing only in who is watching,
//! which is the one thing the trust ladder asks about.

use chrono::Utc;
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{ExpiryStage, ExpirySubject, LifecycleEvent, SubjectKind};

use super::recipe_trust::Attendance;
use super::WebLoginLauncher;
use crate::lifecycle::agent_phase::publish_agent_phase;
use crate::lifecycle::responders::Outcome;

/// The subject an attended run is announced under: the same `web_login`
/// target a scheduled rotation of `origin` would be.
fn subject_event(organization_id: &OrganizationId, origin: &str) -> LifecycleEvent {
    let now = Utc::now();
    LifecycleEvent::for_stage(
        ExpirySubject {
            kind: SubjectKind::WebLogin,
            subject_id: origin.to_owned(),
            organization_id: organization_id.to_string(),
            expires_at: now,
            renew_before_seconds: Some(1),
            auto_respond: false,
            alerting: false,
            label: None,
        },
        ExpiryStage::Renewal,
        now,
    )
}

impl WebLoginLauncher {
    /// Run `origin`'s recipe once, for `owner`, who is driving it.
    pub(crate) async fn rotate_attended(
        &self,
        organization_id: &OrganizationId,
        origin: &str,
        owner: &str,
    ) -> Outcome {
        let ran = self
            .request_and_run(
                organization_id,
                origin,
                Some(owner),
                None,
                Attendance::Attended,
            )
            .await;
        let Ok((outcome, refs)) = ran else {
            return Outcome::ok(format!(
                "attended run for {origin} skipped: a run for it is already in flight"
            ));
        };
        let event = subject_event(organization_id, origin);
        publish_agent_phase(&self.state, &event, Some(owner.to_owned()), &refs, &outcome).await;
        outcome
    }
}
