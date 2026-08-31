//! The watermark table accepts every subject kind the ladder can reach.
//!
//! This exists because it did not, twice. `0017_lifecycle_hooks.sql` enumerated
//! the five subject kinds that existed when the expiry ladder was written;
//! `web_login` (ADR 0081) and `session_grant` (ADR 0079) were added to
//! [`SubjectKind`] later and neither widened the `CHECK`.
//!
//! The failure was silent by construction. `dispatch::publish` records a
//! watermark as a claim — the process that advances it is the one entitled to
//! act — and reads a failed write as "somebody else got there first", so it
//! stands down. A `CHECK` violation is indistinguishable from losing that race,
//! which meant both new kinds published a notice on every scan pass forever and
//! were never once acted on.
//!
//! So the fence is not "remember the migration". It is this file: adding a
//! variant to [`SubjectKind::ALL`] without widening the `CHECK` fails here.

use chrono::{TimeZone as _, Utc};
use opensesame_lifecycle::SubjectKind;
use opensesame_storage::{Db, StoredLifecycleWatermark};

async fn db() -> Db {
    let db = Db::connect_memory().await.expect("in-memory database");
    db.migrate().await.expect("migrations apply");
    db
}

fn watermark(kind: SubjectKind, track: &str, stage: &str) -> StoredLifecycleWatermark {
    StoredLifecycleWatermark {
        organization_id: "org:1".into(),
        subject_kind: kind.as_str().to_string(),
        subject_id: format!("subject-for-{}", kind.as_str()),
        track: track.into(),
        stage: stage.into(),
        threshold_seconds: 3_600,
        expires_at: "2026-12-01T00:00:00+00:00".into(),
    }
}

#[tokio::test]
async fn every_subject_kind_the_ladder_reports_can_claim_a_rung() {
    let db = db().await;
    let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 0, 0).unwrap();

    for kind in SubjectKind::ALL {
        let claimed = db
            .record_lifecycle_watermark(&watermark(kind, "alert", "urgent"), now)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "`{}` cannot record a watermark, so its ladder publishes forever and never \
                     acts — widen the CHECK in a new migration: {error}",
                    kind.as_str(),
                )
            });
        assert!(
            claimed,
            "{} did not advance its own first rung",
            kind.as_str()
        );
    }
}

#[tokio::test]
async fn a_non_renewable_kind_still_records_its_alert_rungs() {
    // `SessionGrant` is never renewed — the platform will not extend one
    // person's reach into another's vault unattended — but telling somebody
    // their access lapses in an hour is exactly what the ladder is for, and
    // that still needs a claim so the notice fires once rather than every pass.
    let db = db().await;
    let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 0, 0).unwrap();
    assert!(!SubjectKind::SessionGrant.renewable());

    let mark = watermark(SubjectKind::SessionGrant, "alert", "warning");
    assert!(db.record_lifecycle_watermark(&mark, now).await.unwrap());
    assert!(
        !db.record_lifecycle_watermark(&mark, now).await.unwrap(),
        "the same rung on the same deadline is a rung that already fired",
    );
}

#[tokio::test]
async fn a_kind_the_enum_does_not_have_is_still_refused() {
    // Widening the CHECK is not dropping it. A subject kind that reaches this
    // table by typo is a claim recorded against nothing, which would let the
    // real subject's rung fire forever beside it.
    let db = db().await;
    let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 0, 0).unwrap();
    let mut bogus = watermark(SubjectKind::WebLogin, "alert", "urgent");
    bogus.subject_kind = "web-login".into();
    assert!(db.record_lifecycle_watermark(&bogus, now).await.is_err());
}

#[tokio::test]
async fn watermarks_written_before_the_widening_survive_it() {
    // The rebuild copies rows rather than starting clean. A watermark is the
    // record that a rung already fired; dropping the table would re-send every
    // expiry notice a deployment has already sent.
    let db = Db::connect_memory().await.expect("in-memory database");
    db.migrate().await.expect("migrations apply");
    let now = Utc.with_ymd_and_hms(2026, 8, 31, 0, 0, 0).unwrap();
    let mark = watermark(SubjectKind::Certificate, "alert", "urgent");
    assert!(db.record_lifecycle_watermark(&mark, now).await.unwrap());

    // Re-running migrations is a no-op, so the row is still a claim afterwards.
    db.migrate().await.expect("migrations are idempotent");
    assert!(
        !db.record_lifecycle_watermark(&mark, now).await.unwrap(),
        "the claim was lost, so this rung would fire a second time",
    );
}
