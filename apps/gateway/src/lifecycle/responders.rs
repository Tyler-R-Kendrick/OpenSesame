//! Platform responders — the dogfooding seam.
//!
//! `OpenSesame`'s own reaction to an expiry runs through exactly the feed a
//! third-party tool subscribes to. There is no private trigger path: the
//! rotation scheduler does not ask "is this policy due?" any more, it consumes
//! `lifecycle.renewal.due` like any other subscriber. If the hook feed breaks,
//! our own rotations break with it, which is the only reliable way to keep a
//! published event contract honest.
//!
//! Responders are platform code, not community code, and the difference is
//! deliberate (ADR 0065 §7): a responder runs in-process and synchronously
//! because rotation needs the broker's authority, while community hooks are
//! observers delivered asynchronously and cannot influence any decision. A
//! connector author never gets to choose which of those they are.

use chrono::Utc;
use opensesame_connection_broker::{
    execute_rotation, request_rotation, RotationPolicy, RotationTarget,
};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{LifecycleEvent, SubjectKind};

use crate::app_state::AppState;

/// Responder id recorded on an internal hook row and in outcome details.
pub const ROTATION_RESPONDER: &str = "rotation";

/// What a responder did, so the caller can publish the matching outcome event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub succeeded: bool,
    pub detail: String,
}

impl Outcome {
    fn ok(detail: impl Into<String>) -> Self {
        Self {
            succeeded: true,
            detail: detail.into(),
        }
    }

    fn failed(detail: impl Into<String>) -> Self {
        Self {
            succeeded: false,
            detail: detail.into(),
        }
    }
}

/// The responder that handles a subject kind, if the platform has one.
///
/// A closed lookup rather than a registry a manifest can extend: acting on an
/// expiry means using the broker's authority, which is Tier X in ADR 0065 —
/// never pluggable. Community code subscribes to `lifecycle.renewal.due` and
/// acts with its own credentials.
#[must_use]
pub fn responder_for(kind: SubjectKind) -> Option<&'static str> {
    match kind {
        SubjectKind::ConnectionCredential | SubjectKind::StorePath => Some(ROTATION_RESPONDER),
        // Leaf certificate reissuance, CA re-keying, and signer rotation have
        // no unattended platform path yet. They are not silently skipped: the
        // dispatcher reports the gap as an outcome event so a subscriber knows
        // the renewal is theirs to perform.
        SubjectKind::Certificate | SubjectKind::CertificateAuthority | SubjectKind::Signer => None,
    }
}

/// Run the platform responder for `event`.
///
/// The caller has already checked [`opensesame_lifecycle::should_respond`].
pub async fn respond(state: &AppState, event: &LifecycleEvent) -> Outcome {
    match responder_for(event.subject.kind) {
        Some(ROTATION_RESPONDER) => rotate(state, event).await,
        Some(other) => Outcome::failed(format!("unknown responder '{other}'")),
        None => Outcome::failed(format!(
            "no platform responder for subject kind '{}'; subscribe to lifecycle.renewal.due to act",
            event.subject.kind.as_str(),
        )),
    }
}

/// Rotate the event's target through the broker's verify-before-revoke machine.
///
/// This is the body the old `rotation_scheduler::execute_due_policy` used to
/// run off its own due-check. The behaviour it preserves exactly:
/// `last_rotated_at` advances after **every** attempt, success or failure, so a
/// broken target retries on its policy interval rather than on every tick.
async fn rotate(state: &AppState, event: &LifecycleEvent) -> Outcome {
    let Some(target) = rotation_target(event) else {
        return Outcome::failed("subject kind is not a rotation target");
    };
    let Ok(organization_id) = OrganizationId::parse(&event.subject.organization_id) else {
        return Outcome::failed("subject carries a non-canonical organization id");
    };

    let broker = state.connection_broker.as_ref();
    let policy = enabled_policy_for(state, event, &target).await;
    let bus = state.task_bus.read().await;
    let requested = request_rotation(
        broker,
        bus.as_ref(),
        target,
        None,
        &event.subject.organization_id,
        policy.as_ref().map(|policy| policy.id.clone()),
    )
    .await;

    let outcome = match requested {
        Err(error) => Outcome::failed(format!("rotation request failed: {}", error.hint())),
        Ok(job) => {
            match execute_rotation(broker, bus.as_ref(), &organization_id, &job.id).await {
                // The failure is already persisted on the job and in the
                // changelog; the outcome event makes it visible to subscribers
                // too, so a broken rotation is never only in our own logs.
                Err(error) => Outcome::failed(format!(
                    "rotation {} failed: {}",
                    job.id,
                    error.hint()
                )),
                Ok(done) => Outcome::ok(format!("rotation {} reached {}", done.id, done.state)),
            }
        }
    };
    drop(bus);

    if let Some(policy) = policy {
        // Attempted counts as rotated for scheduling: retry on the policy's
        // interval, not on every tick. Advancing also moves the subject's
        // deadline, which is what resets the ladder for the next interval.
        if let Err(error) = broker.set_policy_last_rotated(&policy.id, Utc::now()).await {
            tracing::warn!(
                policy_id = %policy.id,
                error = %error.hint(),
                "failed to advance last_rotated_at",
            );
        }
    }
    outcome
}

fn rotation_target(event: &LifecycleEvent) -> Option<RotationTarget> {
    match event.subject.kind {
        SubjectKind::ConnectionCredential => Some(RotationTarget::Connection {
            connection_id: event.subject.subject_id.clone(),
        }),
        SubjectKind::StorePath => Some(RotationTarget::StorePath {
            path: event.subject.subject_id.clone(),
        }),
        _ => None,
    }
}

/// The enabled policy whose target is this subject, if any.
///
/// A rotation can be driven without a policy — an operator-triggered run has
/// none — so this is a lookup, not a requirement.
async fn enabled_policy_for(
    state: &AppState,
    event: &LifecycleEvent,
    target: &RotationTarget,
) -> Option<RotationPolicy> {
    let policies = state
        .connection_broker
        .list_rotation_policies(&event.subject.organization_id)
        .await
        .ok()?;
    policies
        .into_iter()
        .find(|policy| policy.enabled && policy.target == *target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_lifecycle::{ExpirySubject, ExpiryStage};

    fn event(kind: SubjectKind) -> LifecycleEvent {
        LifecycleEvent::for_stage(
            ExpirySubject {
                kind,
                subject_id: "target:1".into(),
                organization_id: "org:1".into(),
                expires_at: "2026-08-30T00:00:00Z".parse().unwrap(),
                renew_before_seconds: Some(1),
                auto_respond: true,
                alerting: false,
                label: None,
            },
            ExpiryStage::Renewal,
            "2026-08-30T00:01:00Z".parse().unwrap(),
        )
    }

    #[test]
    fn rotation_owns_the_kinds_it_can_actually_rotate() {
        assert_eq!(
            responder_for(SubjectKind::ConnectionCredential),
            Some(ROTATION_RESPONDER),
        );
        assert_eq!(
            responder_for(SubjectKind::StorePath),
            Some(ROTATION_RESPONDER),
        );
    }

    #[test]
    fn kinds_without_an_unattended_path_report_no_responder() {
        for kind in [
            SubjectKind::Certificate,
            SubjectKind::CertificateAuthority,
            SubjectKind::Signer,
        ] {
            assert_eq!(responder_for(kind), None, "{kind:?}");
        }
    }

    #[test]
    fn rotation_targets_mirror_the_subject_kind() {
        assert_eq!(
            rotation_target(&event(SubjectKind::ConnectionCredential)),
            Some(RotationTarget::Connection {
                connection_id: "target:1".into(),
            }),
        );
        assert_eq!(
            rotation_target(&event(SubjectKind::StorePath)),
            Some(RotationTarget::StorePath {
                path: "target:1".into(),
            }),
        );
        assert_eq!(rotation_target(&event(SubjectKind::Certificate)), None);
    }

    #[tokio::test]
    async fn an_unhandled_kind_fails_loudly_rather_than_silently() {
        let state = crate::app_state::test_demo_state().await;
        let outcome = respond(&state, &event(SubjectKind::Certificate)).await;
        assert!(!outcome.succeeded);
        assert!(
            outcome.detail.contains("no platform responder"),
            "{}",
            outcome.detail,
        );
        assert!(
            outcome.detail.contains("lifecycle.renewal.due"),
            "the gap must point a subscriber at the event they can act on: {}",
            outcome.detail,
        );
    }
}
