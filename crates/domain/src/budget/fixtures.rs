//! Deterministic time and recurrence fixtures for budget tests.
//!
//! [`super::BudgetLedger`] takes `now` as a parameter precisely so its
//! behaviour at a window boundary is testable, and that only pays off if the
//! tests can name a boundary exactly. Everything here is arithmetic on Unix
//! seconds — no `Utc::now()`, no sleeping, no tolerance windows. A test that
//! spends at `boundary - 1s` and again at `boundary` is asserting about two
//! specific allowances, not hoping a clock cooperated.
//!
//! Test-only (`#[cfg(test)]` in `super`), so none of this reaches a caller.

use chrono::{DateTime, Duration, TimeZone, Utc};

use super::{BudgetKey, Limit, Limits, Quantity, Unit, WindowSpec};

/// An instant from Unix seconds.
///
/// # Panics
///
/// Panics for a value outside `chrono`'s representable range — a fixture that
/// cannot name its own instant is a broken test, not a runtime condition.
#[must_use]
pub fn at(seconds: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(seconds, 0)
        .single()
        .expect("fixture instant is representable")
}

/// A minute-long recurrence, for boundary cases that stay readable.
#[must_use]
pub fn per_minute() -> WindowSpec {
    WindowSpec::periodic(60).expect("60s is a valid period")
}

#[must_use]
pub fn hourly() -> WindowSpec {
    WindowSpec::periodic(3_600).expect("3600s is a valid period")
}

#[must_use]
pub fn daily() -> WindowSpec {
    WindowSpec::periodic(86_400).expect("86400s is a valid period")
}

#[must_use]
pub fn weekly() -> WindowSpec {
    WindowSpec::periodic(7 * 86_400).expect("a week is a valid period")
}

/// The first instant of the recurrence *after* the one containing `from`.
///
/// `None` for [`WindowSpec::Lifetime`], which has no next window: that is the
/// distinction a refill test is usually about.
#[must_use]
pub fn next_boundary(spec: WindowSpec, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let period = i64::from(spec.period_seconds()?);
    // Windows are epoch-anchored and tumbling, so the boundary is a function of
    // the instant: floor to this window's start, then step one period.
    let start = from.timestamp().div_euclid(period) * period;
    Some(at(start + period))
}

/// The last instant of the recurrence containing `from`.
#[must_use]
pub fn last_instant_before_boundary(
    spec: WindowSpec,
    from: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    next_boundary(spec, from).map(|boundary| boundary - Duration::seconds(1))
}

/// A monotonic clock a test drives by hand.
///
/// Mirrors the ledger's own rule — time only moves forward — so a fixture
/// cannot accidentally set up the clock-regression case it meant to assert
/// about deliberately.
#[derive(Clone, Debug)]
pub struct TestClock {
    now: DateTime<Utc>,
}

impl TestClock {
    #[must_use]
    pub fn starting_at(seconds: i64) -> Self {
        Self { now: at(seconds) }
    }

    #[must_use]
    pub const fn now(&self) -> DateTime<Utc> {
        self.now
    }

    /// Advance and return the new instant.
    ///
    /// # Panics
    ///
    /// Panics on a non-positive step: a test that wants time to stand still
    /// should reuse [`TestClock::now`], and one that wants it to go backwards
    /// should say so with an explicit earlier instant.
    pub fn advance_seconds(&mut self, seconds: i64) -> DateTime<Utc> {
        assert!(seconds > 0, "a test clock only moves forward");
        self.now += Duration::seconds(seconds);
        self.now
    }

    /// Jump to the start of the next recurrence of `spec`.
    ///
    /// # Panics
    ///
    /// Panics for [`WindowSpec::Lifetime`], which never refills.
    pub fn advance_to_next_window(&mut self, spec: WindowSpec) -> DateTime<Utc> {
        self.now = next_boundary(spec, self.now).expect("a lifetime budget has no next window");
        self.now
    }
}

/// A validated key, for terse test setup.
///
/// # Panics
///
/// Panics on a key the parser refuses.
#[must_use]
pub fn key(raw: &str) -> BudgetKey {
    BudgetKey::parse(raw).expect("fixture key parses")
}

/// A whole-count limit: `cap` per `window`.
#[must_use]
pub fn count_limit(cap: u128, window: WindowSpec) -> Limit {
    Limit::new(Quantity::from_minor_units(cap), Unit::count(), window)
}

/// Limits from `(key, limit)` pairs.
#[must_use]
pub fn limits(entries: Vec<(&str, Limit)>) -> Limits {
    Limits::new(
        entries
            .into_iter()
            .map(|(raw, limit)| (key(raw), limit))
            .collect(),
    )
}

/// The single most common fixture: one `calls` dimension, `cap` per `window`.
#[must_use]
pub fn calls_limits(cap: u128, window: WindowSpec) -> Limits {
    limits(vec![("calls", count_limit(cap, window))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_are_epoch_anchored() {
        // 01:30:00 sits in the 01:00 hour; its next boundary is 02:00.
        let ninety_minutes = at(5_400);
        assert_eq!(next_boundary(hourly(), ninety_minutes), Some(at(7_200)));
        assert_eq!(
            last_instant_before_boundary(hourly(), ninety_minutes),
            Some(at(7_199))
        );
        assert_eq!(next_boundary(WindowSpec::Lifetime, ninety_minutes), None);
    }

    #[test]
    fn a_boundary_instant_belongs_to_the_window_it_opens() {
        let boundary = next_boundary(hourly(), at(0)).unwrap();
        assert_eq!(boundary, at(3_600));
        assert_eq!(next_boundary(hourly(), boundary), Some(at(7_200)));
        assert_ne!(
            hourly().window_at(boundary),
            hourly().window_at(at(3_599)),
            "the boundary opens a fresh allowance"
        );
    }

    #[test]
    fn the_clock_only_moves_forward() {
        let mut clock = TestClock::starting_at(0);
        assert_eq!(clock.advance_seconds(30), at(30));
        assert_eq!(clock.advance_to_next_window(per_minute()), at(60));
        assert_eq!(clock.advance_to_next_window(hourly()), at(3_600));
        assert_eq!(clock.now(), at(3_600));
    }

    #[test]
    fn recurrence_helpers_are_the_periods_they_claim() {
        assert_eq!(per_minute().period_seconds(), Some(60));
        assert_eq!(hourly().period_seconds(), Some(3_600));
        assert_eq!(daily().period_seconds(), Some(86_400));
        assert_eq!(weekly().period_seconds(), Some(604_800));
    }
}
