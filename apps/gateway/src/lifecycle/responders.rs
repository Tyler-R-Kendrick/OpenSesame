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
use crate::managed_certs;

/// Responder id recorded on an internal hook row and in outcome details.
pub const ROTATION_RESPONDER: &str = "rotation";
/// Responder that reissues certificates the host holds the key for.
pub const CERTIFICATE_RESPONDER: &str = "certificate";

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
        SubjectKind::ConnectionCredential | SubjectKind::StorePath | SubjectKind::WebLogin => {
            Some(ROTATION_RESPONDER)
        }
        // Only certificates the host holds the key for can actually be
        // reissued unattended; `renew_managed` refuses the rest with
        // `NotInCustody`, which becomes the outcome a subscriber reads.
        SubjectKind::Certificate => Some(CERTIFICATE_RESPONDER),
        // Three kinds with no unattended path, for two different reasons.
        //
        // A certificate authority is never re-keyed unattended: it changes
        // trust for everything it signed (ADR 0052-cert). Signer rotation has
        // no unattended path *yet*. A session grant has none and never will —
        // extending one human's reach into another's vault is a decision only
        // a human makes (ADR 0079), which is why `SubjectKind::renewable`
        // refuses it in `should_respond` before the dispatcher is even
        // reached; this is the second fence.
        //
        // None of the three is silently skipped: the dispatcher reports the
        // gap as an outcome event.
        SubjectKind::CertificateAuthority | SubjectKind::Signer | SubjectKind::SessionGrant => None,
    }
}

/// Run the platform responder for `event`.
///
/// The caller has already checked [`opensesame_lifecycle::should_respond`].
pub async fn respond(state: &AppState, event: &LifecycleEvent) -> Outcome {
    match responder_for(event.subject.kind) {
        Some(ROTATION_RESPONDER) => rotate(state, event).await,
        Some(CERTIFICATE_RESPONDER) => renew_certificate(state, event).await,
        Some(other) => Outcome::failed(format!("unknown responder '{other}'")),
        None => Outcome::failed(format!(
            "no platform responder for subject kind '{}'; subscribe to lifecycle.renewal.due to act",
            event.subject.kind.as_str(),
        )),
    }
}

/// Lease held while one process rotates a policy. Longer than a config sync
/// because a rotation talks to a provider; a crashed process releases by the
/// clock rather than by a liveness check.
const ROTATION_LEASE_SECONDS: i64 = 120;
/// First backoff delay after a failed rotation; doubles per attempt.
const ROTATION_BACKOFF_BASE_SECONDS: i64 = 60;
const ROTATION_BACKOFF_CAP_SECONDS: i64 = 3600;
/// Consecutive failures before a policy parks for operator attention.
const ROTATION_MAX_ATTEMPTS: i64 = 8;

/// Backoff for the `attempt`-th consecutive failure (1-based), capped.
fn rotation_backoff_seconds(attempt: i64) -> i64 {
    let shift = u32::try_from(attempt.saturating_sub(1).clamp(0, 32)).unwrap_or(0);
    ROTATION_BACKOFF_BASE_SECONDS
        .saturating_mul(1i64 << shift.min(31))
        .min(ROTATION_BACKOFF_CAP_SECONDS)
}

/// Rotate the event's target through the broker's verify-before-revoke machine.
///
/// The scanner decides *when* a policy is due; this decides *who* acts. A
/// policy-backed rotation is claimed under a lease first, so two gateway
/// processes handling the same scan cannot both rotate one credential — for a
/// password change that is a lockout, not merely waste (ADR 0076).
///
/// Failure no longer just advances `last_rotated_at`. It backs off
/// exponentially and, after `ROTATION_MAX_ATTEMPTS`, **parks** the policy:
/// retrying stops, `enabled` stays true, and `needs_attention` is raised. A
/// rotation policy that silently disabled itself would be the ADR 0052 §11
/// failure mode — the operator believes credentials are rotating when they are
/// not.
async fn rotate(state: &AppState, event: &LifecycleEvent) -> Outcome {
    let Some(target) = rotation_target(event) else {
        return Outcome::failed("subject kind is not a rotation target");
    };
    let Ok(organization_id) = OrganizationId::parse(&event.subject.organization_id) else {
        return Outcome::failed("subject carries a non-canonical organization id");
    };

    let broker = state.connection_broker.as_ref();
    let policy = enabled_policy_for(state, event, &target).await;

    // Claim before acting. A policy-less run is operator-triggered and has no
    // lease to take; a policy-backed one must win its lease or stand down.
    if let Some(policy) = policy.as_ref() {
        match broker
            .claim_rotation_policy(&policy.id, ROTATION_LEASE_SECONDS)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return Outcome::ok(format!(
                    "rotation for policy {} skipped: leased, backing off, or parked",
                    policy.id
                ));
            }
            Err(error) => {
                return Outcome::failed(format!("rotation claim failed: {}", error.hint()));
            }
        }
    }

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
                Err(error) => {
                    Outcome::failed(format!("rotation {} failed: {}", job.id, error.hint()))
                }
                Ok(done) => Outcome::ok(format!("rotation {} reached {}", done.id, done.state)),
            }
        }
    };
    drop(bus);

    if let Some(policy) = policy {
        release_policy(broker, &policy, &outcome).await;
    }
    outcome
}

/// Releases the lease taken above.
///
/// Success advances `last_rotated_at` and schedules the next attempt one
/// interval out, which is what moves the subject's deadline and resets the
/// ladder. Failure backs off, and parks once the attempts are exhausted.
async fn release_policy(
    broker: &opensesame_connection_broker::ConnectionBroker,
    policy: &RotationPolicy,
    outcome: &Outcome,
) {
    let now = Utc::now();
    let released = if outcome.succeeded {
        broker.release_rotation_policy_success(policy, now).await
    } else {
        let attempt = policy.attempts.saturating_add(1);
        let next_attempt_at = if attempt >= ROTATION_MAX_ATTEMPTS {
            None
        } else {
            Some(now + chrono::Duration::seconds(rotation_backoff_seconds(attempt)))
        };
        broker
            .release_rotation_policy_failure(&policy.id, next_attempt_at, &outcome.detail)
            .await
    };
    if let Err(error) = released {
        tracing::warn!(
            policy_id = %policy.id,
            error = %error.hint(),
            "failed to release the rotation policy lease",
        );
    }
}

/// Reissue a certificate the host holds the key for.
///
/// The custody check lives in [`crate::managed_certs::renew_managed`] rather
/// than here, so the same refusal reaches an operator calling the route and a
/// subscriber reading the hook feed. A certificate whose key was delivered to
/// its requester reports `not_in_custody`: the platform genuinely cannot renew
/// it, because a new key would have nobody to go to.
async fn renew_certificate(state: &AppState, event: &LifecycleEvent) -> Outcome {
    let Ok(organization_id) = OrganizationId::parse(&event.subject.organization_id) else {
        return Outcome::failed("subject carries a non-canonical organization id");
    };
    match managed_certs::renew_managed(state, &organization_id, &event.subject.subject_id).await {
        Ok(renewed) => Outcome::ok(format!(
            "reissued as {} valid until {}",
            renewed.id, renewed.expires_at
        )),
        Err(error) => Outcome::failed(format!("{}: {error}", error.code())),
    }
}

fn rotation_target(event: &LifecycleEvent) -> Option<RotationTarget> {
    match event.subject.kind {
        SubjectKind::ConnectionCredential => Some(RotationTarget::Connection {
            connection_id: event.subject.subject_id.clone(),
        }),
        SubjectKind::WebLogin => Some(RotationTarget::WebLogin {
            origin: event.subject.subject_id.clone(),
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
    use opensesame_lifecycle::{ExpiryStage, ExpirySubject};

    fn event(kind: SubjectKind) -> LifecycleEvent {
        event_in(kind, &OrganizationId::new().to_string())
    }

    fn event_in(kind: SubjectKind, organization_id: &str) -> LifecycleEvent {
        LifecycleEvent::for_stage(
            ExpirySubject {
                kind,
                subject_id: "target:1".into(),
                organization_id: organization_id.to_string(),
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
    fn certificates_are_reissued_by_the_certificate_responder() {
        assert_eq!(
            responder_for(SubjectKind::Certificate),
            Some(CERTIFICATE_RESPONDER),
        );
    }

    #[test]
    fn kinds_without_an_unattended_path_report_no_responder() {
        for kind in [
            SubjectKind::CertificateAuthority,
            SubjectKind::Signer,
            // A session grant is the strongest case of this: not "no
            // unattended path yet" but never one, because extending one
            // human's reach into another's vault is a human decision
            // (ADR 0079). `should_respond` refuses the kind before the
            // dispatcher is reached; this is the second fence.
            SubjectKind::SessionGrant,
        ] {
            assert_eq!(responder_for(kind), None, "{kind:?}");
        }
    }

    #[test]
    fn every_kind_is_accounted_for_by_the_responder_lookup() {
        // The closed set exists so adding a kind is an explicit choice about
        // what acts on it. This walks the whole set rather than a list that
        // could silently fall behind it.
        for kind in SubjectKind::ALL {
            let has_responder = responder_for(kind).is_some();
            assert_eq!(
                has_responder,
                kind.renewable()
                    && !matches!(
                        kind,
                        SubjectKind::CertificateAuthority | SubjectKind::Signer
                    ),
                "{kind:?} responder presence"
            );
        }
    }

    #[tokio::test]
    async fn a_non_canonical_organization_is_refused_rather_than_guessed() {
        let state = crate::app_state::test_demo_state().await;
        let outcome = respond(
            &state,
            &event_in(SubjectKind::Certificate, "org:not-a-uuid"),
        )
        .await;
        assert!(!outcome.succeeded);
        assert!(
            outcome.detail.contains("non-canonical"),
            "{}",
            outcome.detail
        );
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
        let outcome = respond(&state, &event(SubjectKind::Signer)).await;
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

    #[tokio::test]
    async fn a_certificate_the_host_holds_no_key_for_reports_why_it_cannot_be_renewed() {
        // The honest refusal: a delivered certificate's key went to its
        // requester, so a reissue would mint a key with nobody to give it to.
        let state = crate::app_state::test_demo_state().await;
        let outcome = respond(&state, &event(SubjectKind::Certificate)).await;
        assert!(!outcome.succeeded);
        assert!(
            outcome.detail.starts_with("not_found") || outcome.detail.starts_with("not_in_custody"),
            "{}",
            outcome.detail,
        );
    }
}
