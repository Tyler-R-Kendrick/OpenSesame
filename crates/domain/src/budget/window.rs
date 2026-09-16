//! When a budget resets (BUD-TIME).
//!
//! A cap means nothing without a period: "ten calls" is a different authority
//! from "ten calls an hour". A [`WindowSpec`] says which, and resolves an
//! instant to the [`WindowId`] whose bucket that instant spends from.
//!
//! Windows are **tumbling and anchored at the Unix epoch**, not at first use.
//! Two hosts holding the same limit therefore agree on where every boundary
//! falls without exchanging state, and a restart cannot hand a spender a fresh
//! allowance by starting the clock again. The boundary is a function of the
//! instant, so the same `now` always names the same window.

use std::num::NonZeroU32;

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use super::BudgetError;

/// Longest period accepted: 366 days. Past that, a "recurring" budget is a
/// lifetime budget wearing a costume, and [`WindowSpec::Lifetime`] says so
/// honestly.
pub const MAX_PERIOD_SECONDS: u32 = 366 * 24 * 60 * 60;

/// Whether a budget refills, and how often.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum WindowSpec {
    /// Spend it once. Never refills — the cap is the total, for good.
    Lifetime,
    /// Refills every `period_seconds`, on epoch-aligned boundaries.
    Periodic { period_seconds: NonZeroU32 },
}

impl WindowSpec {
    /// # Errors
    ///
    /// Returns [`BudgetError::InvalidWindow`] for a zero period or one over
    /// [`MAX_PERIOD_SECONDS`].
    pub fn periodic(period_seconds: u32) -> Result<Self, BudgetError> {
        let period = NonZeroU32::new(period_seconds).ok_or_else(|| {
            BudgetError::InvalidWindow("a period of zero seconds never elapses".to_string())
        })?;
        if period_seconds > MAX_PERIOD_SECONDS {
            return Err(BudgetError::InvalidWindow(format!(
                "{period_seconds}s is over the {MAX_PERIOD_SECONDS}s maximum; use a lifetime budget"
            )));
        }
        Ok(Self::Periodic {
            period_seconds: period,
        })
    }

    /// Period length, or `None` for [`WindowSpec::Lifetime`].
    #[must_use]
    pub const fn period_seconds(self) -> Option<u32> {
        match self {
            Self::Lifetime => None,
            Self::Periodic { period_seconds } => Some(period_seconds.get()),
        }
    }

    /// The bucket `at` spends from.
    #[must_use]
    pub fn window_at(self, at: DateTime<Utc>) -> WindowId {
        match self {
            Self::Lifetime => WindowId::Lifetime,
            Self::Periodic { period_seconds } => {
                let period = i64::from(period_seconds.get());
                // Euclidean so instants before 1970 floor downwards too,
                // instead of collapsing two windows onto index 0.
                WindowId::Periodic {
                    period_seconds: period_seconds.get(),
                    index: at.timestamp().div_euclid(period),
                }
            }
        }
    }
}

/// The identity of one refill period. Ordered so it can key a `BTreeMap`; the
/// order is chronological within a single period length and carries no
/// meaning across different ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum WindowId {
    Lifetime,
    Periodic { period_seconds: u32, index: i64 },
}

impl WindowId {
    /// The first instant this window covers.
    ///
    /// `None` for [`WindowId::Lifetime`], which has no beginning to speak of,
    /// and for a periodic index so far out that the instant is not
    /// representable.
    #[must_use]
    pub fn starts_at(self) -> Option<DateTime<Utc>> {
        let Self::Periodic {
            period_seconds,
            index,
        } = self
        else {
            return None;
        };
        let start = index.checked_mul(i64::from(period_seconds))?;
        Utc.timestamp_opt(start, 0).single()
    }

    /// The instant this window ends, which is the first instant of the next one.
    ///
    /// Exclusive: the returned instant is *not* part of this window. That is
    /// what makes the windows a partition of time rather than a set of
    /// overlapping guesses, and it is the bound a hold's deadline is clamped to
    /// so that no spend is recorded against an allowance that already refilled.
    ///
    /// `None` for [`WindowId::Lifetime`], which never ends.
    #[must_use]
    pub fn ends_at(self) -> Option<DateTime<Utc>> {
        let Self::Periodic {
            period_seconds,
            index,
        } = self
        else {
            return None;
        };
        let end = index
            .checked_add(1)?
            .checked_mul(i64::from(period_seconds))?;
        Utc.timestamp_opt(end, 0).single()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0).single().expect("valid time")
    }

    #[test]
    fn a_lifetime_budget_has_exactly_one_window() {
        let spec = WindowSpec::Lifetime;
        assert_eq!(spec.window_at(at(0)), WindowId::Lifetime);
        assert_eq!(spec.window_at(at(10_000_000_000)), WindowId::Lifetime);
    }

    #[test]
    fn periods_are_epoch_aligned_not_first_use_aligned() {
        let hourly = WindowSpec::periodic(3_600).unwrap();
        // 00:59:59 and 01:00:00 are different allowances; 01:00:00 and
        // 01:59:59 are the same one.
        assert_eq!(hourly.window_at(at(3_599)), hourly.window_at(at(0)));
        assert_ne!(hourly.window_at(at(3_600)), hourly.window_at(at(3_599)));
        assert_eq!(hourly.window_at(at(3_600)), hourly.window_at(at(7_199)));
    }

    #[test]
    fn instants_before_the_epoch_do_not_collapse_together() {
        let hourly = WindowSpec::periodic(3_600).unwrap();
        assert_ne!(hourly.window_at(at(-1)), hourly.window_at(at(0)));
        assert_ne!(hourly.window_at(at(-3_601)), hourly.window_at(at(-1)));
    }

    #[test]
    fn a_window_of_a_different_length_is_a_different_window() {
        let hourly = WindowSpec::periodic(3_600).unwrap();
        let daily = WindowSpec::periodic(86_400).unwrap();
        assert_ne!(hourly.window_at(at(0)), daily.window_at(at(0)));
    }

    #[test]
    fn refuses_periods_that_are_not_periods() {
        assert!(WindowSpec::periodic(0).is_err());
        assert!(WindowSpec::periodic(MAX_PERIOD_SECONDS + 1).is_err());
        assert!(WindowSpec::periodic(MAX_PERIOD_SECONDS).is_ok());
    }
}
