use std::time::Duration;

use chrono::{TimeZone as _, Utc};

use super::{retention_deadline, stale_deadline, Backoff, ReconnectPolicy};

fn policy(initial_ms: u64, max_ms: u64, jitter: u32) -> ReconnectPolicy {
    ReconnectPolicy {
        initial: Duration::from_millis(initial_ms),
        max: Duration::from_millis(max_ms),
        jitter_permille: jitter,
    }
}

#[test]
fn backoff_doubles_and_caps_without_jitter() {
    let mut b = Backoff::new(policy(100, 450, 0), 7);
    let delays: Vec<u128> = (0..5).map(|_| b.next_delay().as_millis()).collect();
    assert_eq!(delays, vec![100, 200, 400, 450, 450]);
    assert_eq!(b.attempts(), 5);
    b.reset();
    assert_eq!(b.next_delay().as_millis(), 100);
}

#[test]
fn backoff_jitter_stays_within_band_and_is_deterministic() {
    let mut a = Backoff::new(policy(1000, 8000, 250), 42);
    let mut b = Backoff::new(policy(1000, 8000, 250), 42);
    for i in 0..12u32 {
        let base = (1000u64 << i.min(31)).min(8000);
        let da = u64::try_from(a.next_delay().as_millis()).unwrap();
        let db = u64::try_from(b.next_delay().as_millis()).unwrap();
        assert_eq!(da, db, "same seed, same schedule");
        assert!(
            da >= base - base / 4 && da <= base + base / 4,
            "{da} vs {base}"
        );
    }
}

#[test]
fn backoff_never_panics_at_huge_attempt_counts() {
    let mut b = Backoff::new(policy(1, 10, 1000), 1);
    for _ in 0..100 {
        let d = b.next_delay();
        assert!(d <= Duration::from_millis(20));
    }
}

#[test]
fn policy_validation_rejects_impossible_values() {
    assert!(policy(0, 10, 0).validate().is_err());
    assert!(policy(20, 10, 0).validate().is_err());
    assert!(policy(1, 10, 1001).validate().is_err());
    assert!(ReconnectPolicy::default().validate().is_ok());
}

#[test]
fn stale_deadline_is_the_earlier_bound_and_never_extends_not_after() {
    let outage = Utc.with_ymd_and_hms(2026, 9, 22, 10, 0, 0).unwrap();
    let not_after = Utc.with_ymd_and_hms(2026, 9, 22, 11, 0, 0).unwrap();
    assert_eq!(
        stale_deadline(not_after, outage, Duration::from_secs(600)),
        Utc.with_ymd_and_hms(2026, 9, 22, 10, 10, 0).unwrap()
    );
    assert_eq!(
        stale_deadline(not_after, outage, Duration::from_secs(7200)),
        not_after
    );
    assert_eq!(
        stale_deadline(not_after, outage, Duration::MAX),
        not_after,
        "an overflowing max_stale collapses to not_after, never beyond"
    );
    assert_eq!(retention_deadline(not_after, None), not_after);
    assert_eq!(
        retention_deadline(not_after, Some((outage, Duration::from_secs(1)))),
        outage + chrono::Duration::seconds(1)
    );
}
