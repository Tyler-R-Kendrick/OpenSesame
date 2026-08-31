//! The expiry scanner: one pass gathers every deadline, asks the pure
//! evaluator what each one owes, and hands the result to the dispatcher.
//!
//! This loop replaces the rotation scheduler's private due-check. There is now
//! one detector for every kind of expiry, and the rotation responder is one of
//! its subscribers rather than a second, parallel notion of "due".

use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{evaluate, ExpiryStage, ExpirySubject, Track, Watermark, Watermarks};
use opensesame_storage::StoredLifecycleWatermark;

use crate::app_state::AppState;
use crate::lifecycle::{dispatch, subjects};

const DEFAULT_TICK_SECONDS: u64 = 60;

/// Tick interval, overridable for tests and tight-loop deployments.
///
/// `OPENSESAME_ROTATION_TICK_SECONDS` is honoured as well as the lifecycle
/// name: the rotation scheduler this loop absorbed was configured with it, and
/// silently ignoring an operator's existing setting would change their rotation
/// cadence during an upgrade.
fn tick_seconds() -> u64 {
    [
        "OPENSESAME_LIFECYCLE_TICK_SECONDS",
        "OPENSESAME_ROTATION_TICK_SECONDS",
    ]
    .into_iter()
    .find_map(|name| std::env::var(name).ok())
    .and_then(|raw| raw.parse::<u64>().ok())
    .filter(|seconds| *seconds >= 1)
    .unwrap_or(DEFAULT_TICK_SECONDS)
}

/// Process-lifetime scanner loop, spawned from `main` beside the backup actor.
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(tick_seconds()));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pass(&state, Utc::now()).await {
            Ok(0) => {}
            Ok(fired) => tracing::info!(fired, "lifecycle scan published expiry events"),
            Err(error) => tracing::warn!(%error, "lifecycle scan failed"),
        }
    }
}

/// One scanner pass over one organization's deadlines. Returns how many events
/// were published.
///
/// # Errors
///
/// Returns an error only when the watermark table cannot be read. A single
/// unreadable source is logged inside [`subjects::collect`] and skipped, so one
/// broken table never stops a renewal elsewhere.
pub async fn pass(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<usize> {
    scan_organization(state, &state.connection_organization.clone(), now).await
}

/// Evaluate every subject in one organization and publish what it owes.
///
/// # Errors
///
/// Returns an error when the watermark table cannot be read.
pub async fn scan_organization(
    state: &AppState,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
) -> anyhow::Result<usize> {
    let organization = organization_id.to_string();
    let stored = state.db.list_lifecycle_watermarks(&organization).await?;
    let subjects = subjects::collect(state, organization_id, now).await;

    let mut fired = 0usize;
    for subject in subjects {
        for event in evaluate(&subject, watermarks_for(&subject, &stored), now) {
            dispatch::publish(state, &event, now).await;
            fired += 1;
        }
    }
    Ok(fired)
}

/// The stored watermarks belonging to one subject, decoded into the evaluator's
/// shape. A row that will not decode is treated as absent, which re-fires its
/// rung — noisy, and the safe direction: the alternative is a stuck ladder that
/// never warns again.
fn watermarks_for(subject: &ExpirySubject, stored: &[StoredLifecycleWatermark]) -> Watermarks {
    Watermarks::from_rows(
        stored
            .iter()
            .filter(|row| {
                row.subject_kind == subject.kind.as_str() && row.subject_id == subject.subject_id
            })
            .filter_map(decode_watermark),
    )
}

fn decode_watermark(row: &StoredLifecycleWatermark) -> Option<Watermark> {
    Some(Watermark {
        track: Track::parse(&row.track)?,
        stage: ExpiryStage::parse(&row.stage)?,
        threshold_seconds: row.threshold_seconds,
        expires_at: DateTime::parse_from_rfc3339(&row.expires_at)
            .ok()?
            .with_timezone(&Utc),
    })
}

/// Everything currently tracked, for the read-only inventory route.
///
/// This is the "what would fire, and when" view an operator or a tool asks for
/// before registering a hook.
pub async fn inventory(
    state: &AppState,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
) -> Vec<ExpirySubject> {
    let mut subjects = subjects::collect(state, organization_id, now).await;
    subjects.sort_by(|left, right| {
        left.expires_at
            .cmp(&right.expires_at)
            .then_with(|| left.subject_id.cmp(&right.subject_id))
    });
    subjects
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::test_demo_state;
    use opensesame_connection_broker::{RotationTarget, UpsertRotationPolicy};
    use opensesame_lifecycle::SubjectKind;

    fn subject() -> ExpirySubject {
        ExpirySubject {
            kind: SubjectKind::Certificate,
            subject_id: "cert:1".into(),
            organization_id: "org:1".into(),
            expires_at: "2026-09-30T00:00:00Z".parse().unwrap(),
            renew_before_seconds: Some(86_400),
            auto_respond: true,
            alerting: true,
            label: None,
        }
    }

    fn row(track: &str, stage: &str, expires_at: &str) -> StoredLifecycleWatermark {
        StoredLifecycleWatermark {
            organization_id: "org:1".into(),
            subject_kind: "certificate".into(),
            subject_id: "cert:1".into(),
            track: track.into(),
            stage: stage.into(),
            threshold_seconds: 2_592_000,
            expires_at: expires_at.into(),
        }
    }

    #[test]
    fn watermarks_are_matched_to_their_own_subject() {
        let mut foreign = row("alert", "notice", "2026-09-30T00:00:00+00:00");
        foreign.subject_id = "cert:2".into();
        let mut other_kind = row("alert", "notice", "2026-09-30T00:00:00+00:00");
        other_kind.subject_kind = "signer".into();

        let marks = watermarks_for(
            &subject(),
            &[
                foreign,
                other_kind,
                row("alert", "notice", "2026-09-30T00:00:00+00:00"),
            ],
        );
        assert_eq!(marks.alert.map(|m| m.stage), Some(ExpiryStage::Notice));
        assert_eq!(marks.renewal, None);
    }

    #[test]
    fn an_undecodable_watermark_is_treated_as_absent() {
        // Absent re-fires the rung. Noisy, and the safe direction: the
        // alternative is a subject that silently never warns again.
        let marks = watermarks_for(
            &subject(),
            &[
                row("alert", "not-a-stage", "2026-09-30T00:00:00+00:00"),
                row("renewal", "renewal", "not a timestamp"),
            ],
        );
        assert_eq!(marks, Watermarks::default());
    }

    #[test]
    fn both_tracks_decode_into_their_own_slots() {
        let marks = watermarks_for(
            &subject(),
            &[
                row("alert", "urgent", "2026-09-30T00:00:00+00:00"),
                row("renewal", "renewal", "2026-09-30T00:00:00+00:00"),
            ],
        );
        assert_eq!(marks.alert.map(|m| m.stage), Some(ExpiryStage::Urgent));
        assert_eq!(marks.renewal.map(|m| m.stage), Some(ExpiryStage::Renewal));
    }

    #[test]
    fn a_watermark_for_a_superseded_deadline_does_not_suppress() {
        // Recorded against last year's deadline: the subject was renewed, and
        // the ladder has to start over.
        let marks = watermarks_for(
            &subject(),
            &[row("alert", "expired", "2025-09-30T00:00:00+00:00")],
        );
        let events = evaluate(&subject(), marks, "2026-09-29T00:00:00Z".parse().unwrap());
        assert!(
            !events.is_empty(),
            "a stale watermark must not silence a subject"
        );
    }

    // —— the dogfood ————————————————————————————————————————————————
    //
    // These are the rotation scheduler's own tests, moved onto the hook path.
    // They assert the same observable behaviour as before — a never-rotated
    // policy runs once, `last_rotated_at` advances, a disabled policy never
    // runs — while the mechanism underneath is now the published feed. If the
    // hook stops firing, these fail.

    #[tokio::test]
    async fn a_due_rotation_policy_is_rotated_through_the_hook() {
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

        let now = Utc::now();
        assert_eq!(
            pass(&st, now).await.unwrap(),
            1,
            "a never-rotated policy is due, and the renewal rung is what says so",
        );

        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1, "the hook issued exactly one rotation");
        assert_eq!(jobs[0].policy_id.as_deref(), Some(policy.id.as_str()));
        assert_eq!(jobs[0].state, "reconciliation_required");

        // last_rotated_at advanced, which moves the subject's deadline, which
        // is what stops the rung re-firing on the next tick.
        let policies = st
            .connection_broker
            .list_rotation_policies(&org)
            .await
            .unwrap();
        assert!(policies[0].last_rotated_at.is_some());
        assert_eq!(
            pass(&st, Utc::now()).await.unwrap(),
            0,
            "not due again until the interval elapses",
        );
        assert_eq!(
            st.connection_broker
                .list_rotation_jobs(&org, 10)
                .await
                .unwrap()
                .len(),
            1,
        );
    }

    #[tokio::test]
    async fn a_disabled_policy_is_never_rotated() {
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
        assert_eq!(pass(&st, Utc::now()).await.unwrap(), 0);
        assert!(st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_rotation_records_its_watermarks_on_the_renewal_track_only() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        st.connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath {
                        path: "Dev/quiet".into(),
                    },
                    interval_seconds: 60,
                    enabled: true,
                },
            )
            .await
            .unwrap();
        pass(&st, Utc::now()).await.unwrap();

        let marks = st
            .db
            .get_lifecycle_watermarks(&org, "store_path", "Dev/quiet")
            .await
            .unwrap();
        assert_eq!(
            marks.iter().map(|m| m.track.as_str()).collect::<Vec<_>>(),
            ["renewal"],
            "a schedule must not narrate on the alert track: {marks:?}",
        );
    }

    #[tokio::test]
    async fn a_scan_with_nothing_to_report_is_silent() {
        let st = test_demo_state().await;
        assert_eq!(pass(&st, Utc::now()).await.unwrap(), 0);
    }
}
