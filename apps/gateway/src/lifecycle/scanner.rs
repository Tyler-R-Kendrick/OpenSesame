//! The expiry scanner: one pass gathers every deadline, asks the pure
//! evaluator what each one owes, and hands the result to the dispatcher.
//!
//! This loop replaces the rotation scheduler's private due-check. There is now
//! one detector for every kind of expiry, and the rotation responder is one of
//! its subscribers rather than a second, parallel notion of "due".

use std::collections::BTreeMap;
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

/// One scanner pass over every tenant's deadlines. Returns how many events
/// were published.
///
/// A per-organization failure is logged and skipped rather than aborting the
/// sweep: one tenant with an unreadable table must not stop another tenant's
/// certificate from being renewed.
///
/// # Errors
///
/// Returns an error only when the tenant list itself cannot be read.
pub async fn pass(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<usize> {
    let mut published = 0usize;
    for organization_id in scannable_organizations(state).await {
        match scan_organization(state, &organization_id, now).await {
            Ok(count) => published += count,
            Err(error) => tracing::warn!(
                %error,
                organization_id = %organization_id,
                "lifecycle scan skipped an organization",
            ),
        }
    }
    Ok(published)
}

/// Every organization a scan pass should sweep.
///
/// Shared with the breach scanner ([`crate::breach`]): tenant discovery is a
/// property of the deployment, not of what is being scanned, and two detectors
/// disagreeing about which tenants exist is a bug waiting to be found in
/// production.
///
/// The union of three sources, because no single one is complete:
///
/// - the gateway's configured organization, which in a deployment without a
///   demo bootstrap is the nil UUID and has no `organizations` row at all;
/// - the tenant registry, which is what makes the sweep multi-tenant;
/// - the organizations named by enabled rotation policies, whose table carries
///   no foreign key into the registry and so can name one that is not there.
///
/// Ids that are not canonical are skipped at `debug`, not `warn`: a stray row
/// is a data artifact, and warning about it on every tick would be noise.
pub async fn scannable_organizations(state: &AppState) -> Vec<OrganizationId> {
    // Keyed on the canonical string rather than the id: `OrganizationId` is
    // `Hash` but not `Ord`, and a deterministic sweep order is worth more here
    // than saving the formatting.
    let mut found: BTreeMap<String, OrganizationId> = BTreeMap::new();
    let mut remember = |id: OrganizationId| {
        found.insert(id.to_string(), id);
    };
    remember(state.connection_organization);

    match state.db.list_organization_ids().await {
        Ok(ids) => {
            for id in ids.iter().filter_map(|id| parse_organization(id)) {
                remember(id);
            }
        }
        Err(error) => tracing::warn!(%error, "lifecycle scan could not read the tenant registry"),
    }
    match state
        .connection_broker
        .list_enabled_rotation_policies()
        .await
    {
        Ok(policies) => {
            for id in policies
                .iter()
                .filter_map(|policy| parse_organization(&policy.organization_id))
            {
                remember(id);
            }
        }
        Err(error) => tracing::warn!(
            error = %error.hint(),
            "lifecycle scan could not read rotation policies for tenant discovery",
        ),
    }
    found.into_values().collect()
}

fn parse_organization(raw: &str) -> Option<OrganizationId> {
    let parsed = OrganizationId::parse(raw).ok();
    if parsed.is_none() {
        tracing::debug!(
            organization_id = raw,
            "skipping a non-canonical organization id"
        );
    }
    parsed
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
    // The feed's built-in subscribers are seeded here as well as by the breach
    // scanner, on purpose. They belong to the *feed*, not to either detector,
    // and seeding them from only one would mean the guarantee that every
    // security event reaches a notifier quietly depended on that detector
    // running — and, at startup, on it winning a race against this loop.
    // Seeding is a conditional insert, so doing it from both is free.
    crate::security::hooks::ensure_defaults(state, &organization, now).await;
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

    /// Two gateway processes scanning the same due policy must produce one
    /// rotation, not two. The scanner has no view of concurrency — it evaluates
    /// watermarks and responds — so the rotation responder claims a lease
    /// before acting (ADR 0076). Concurrently rotating one credential twice is
    /// a lockout, not merely wasted work.
    #[tokio::test]
    async fn concurrent_scans_rotate_a_due_policy_once() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        st.connection_broker
            .upsert_rotation_policy(
                &org,
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath {
                        path: "Dev/contended".into(),
                    },
                    interval_seconds: 3600,
                    enabled: true,
                },
            )
            .await
            .unwrap();

        let now = Utc::now();
        let (first, second) = tokio::join!(pass(&st, now), pass(&st, now));
        first.unwrap();
        second.unwrap();

        let jobs = st
            .connection_broker
            .list_rotation_jobs(&org, 10)
            .await
            .unwrap();
        assert_eq!(
            jobs.len(),
            1,
            "the lease admits one rotation even when both scans fire the rung",
        );
    }

    /// A rotation that keeps failing backs off and then parks: it stops
    /// retrying, stays enabled, and is flagged. Auto-disabling would hide a
    /// rotation that is not happening (ADR 0052 §11).
    #[tokio::test]
    async fn a_failing_policy_parks_without_disabling_itself() {
        let st = test_demo_state().await;
        let org = st.connection_organization.to_string();
        // A connection target naming a connection that does not exist fails on
        // every attempt.
        let policy = st
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
            .unwrap();

        // Drive failures directly: the responder's backoff otherwise holds the
        // policy off for a minute between scans.
        for _ in 0..8 {
            assert!(
                st.connection_broker
                    .claim_rotation_policy(&policy.id, 0)
                    .await
                    .unwrap(),
                "an un-parked policy is claimable",
            );
            let current = st
                .connection_broker
                .list_rotation_policies(&org)
                .await
                .unwrap()
                .into_iter()
                .find(|p| p.id == policy.id)
                .expect("policy");
            let next = (current.attempts < 7).then(Utc::now);
            st.connection_broker
                .release_rotation_policy_failure(&policy.id, next, "provider unreachable")
                .await
                .unwrap();
        }

        let parked = st
            .connection_broker
            .list_rotation_policies(&org)
            .await
            .unwrap()
            .into_iter()
            .find(|p| p.id == policy.id)
            .expect("policy");
        assert!(parked.enabled, "a parked policy stays enabled and visible");
        assert!(parked.needs_attention, "and is flagged for the operator");
        assert!(
            parked.next_attempt_at.is_none(),
            "parked means no next attempt"
        );
        assert!(parked.last_error.is_some(), "with a hint");

        assert!(
            !st.connection_broker
                .claim_rotation_policy(&policy.id, 600)
                .await
                .unwrap(),
            "a parked policy is not claimed again",
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
    async fn the_tick_sweeps_every_tenant_not_just_the_configured_one() {
        let st = test_demo_state().await;
        let configured = st.connection_organization;
        // A second tenant with its own rotation policy. Before the sweep was
        // multi-tenant this org's deadlines were only ever reached by someone
        // calling the on-demand route by hand.
        let second = OrganizationId::new();
        st.db
            .create_organization(&second, "Second tenant")
            .await
            .unwrap();
        st.connection_broker
            .upsert_rotation_policy(
                &second.to_string(),
                UpsertRotationPolicy {
                    id: None,
                    target: RotationTarget::StorePath {
                        path: "Second/api-token".into(),
                    },
                    interval_seconds: 3_600,
                    enabled: true,
                },
            )
            .await
            .unwrap();

        let organizations = scannable_organizations(&st).await;
        assert!(organizations.contains(&configured), "{organizations:?}");
        assert!(organizations.contains(&second), "{organizations:?}");

        assert_eq!(
            pass(&st, Utc::now()).await.unwrap(),
            1,
            "the second tenant's policy must come due on the tick",
        );
        let marks = st
            .db
            .get_lifecycle_watermarks(&second.to_string(), "store_path", "Second/api-token")
            .await
            .unwrap();
        assert_eq!(marks.len(), 1, "the second tenant advanced its own ladder");
    }

    #[tokio::test]
    async fn the_configured_organization_is_swept_without_a_tenant_row() {
        // The nil-UUID deployment: no `organizations` row exists, and the
        // configured organization still has to be swept.
        let st = test_demo_state().await;
        assert!(scannable_organizations(&st)
            .await
            .contains(&st.connection_organization));
    }

    #[tokio::test]
    async fn a_non_canonical_organization_id_is_skipped_not_fatal() {
        let st = test_demo_state().await;
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind("not-a-uuid")
            .bind("Stray")
            .bind("2026-08-30T00:00:00+00:00")
            .execute(st.db.pool())
            .await
            .unwrap();
        // The stray row must not appear, and must not stop the sweep.
        let organizations = scannable_organizations(&st).await;
        assert!(organizations.contains(&st.connection_organization));
        assert!(pass(&st, Utc::now()).await.is_ok());
    }

    #[tokio::test]
    async fn a_scan_with_nothing_to_report_is_silent() {
        let st = test_demo_state().await;
        assert_eq!(pass(&st, Utc::now()).await.unwrap(), 0);
    }
}
