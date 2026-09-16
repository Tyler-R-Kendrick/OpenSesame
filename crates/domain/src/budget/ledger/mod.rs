//! The book of record (BUD-LEDGER): state, time, and conservation.
//!
//! [`BudgetLedger`] holds the running totals and the open holds; the two-phase
//! spending that moves quantity between them lives in [`spend`].
//!
//! # Conservation
//!
//! For every `(key, window)` bucket, `spent + held` never exceeds the cap. That
//! is what makes a root's capacity finite no matter how many consumers draw on
//! it: reserving moves quantity from *available* to *held*, settling moves it
//! from *held* to *spent*, and no operation creates any.
//! [`BudgetLedger::assert_conserved`] verifies it — including that the held total
//! equals the sum of the open holds, which is the half that catches a *leaked*
//! hold rather than merely an over-spend.
//!
//! # No clock, no lock
//!
//! `now` is always a parameter and there is no interior mutability. A ledger that
//! read the wall clock could not be tested at a window boundary, and one that
//! took a lock would impose its consistency model on every store that hosts it.
//! Concurrency is instead an optimistic [`version`]: a caller that read state at
//! version *V* commits with [`BudgetLedger::reserve_expecting`] and is told
//! [`BudgetError::VersionConflict`] if anyone committed first.
//!
//! The version counts **committed caller operations only**. Hold expiry and
//! window rollover do not advance it, because both are deterministic functions
//! of `now` that any reader can compute for itself, and both can only *release*
//! capacity. Counting them would make every compare-and-set loop lose races
//! against the passage of time and spin.
//!
//! # Holds do not outlive their window
//!
//! A hold is charged to the window that was open when it was taken, and its
//! deadline is shortened to that window's end. Otherwise a hold taken at 10:59
//! and settled at 11:01 would record a spend against an allowance that has
//! already closed and refilled — the same quantity charged twice, once as a hold
//! in the old window and once as a spend in the new one.
//!
//! [`version`]: BudgetLedger::version

mod spend;

#[cfg(test)]
mod conservation;
#[cfg(test)]
mod parallel;
#[cfg(test)]
mod testkit;

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    BudgetError, BudgetKey, Limit, Limits, MeterReading, Quantity, Reservation, ReservationId,
    ReservationOutcome, SettlementReceipt, WindowId,
};

/// One `(key, window)` bucket's running totals.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Balance {
    window: WindowId,
    spent: Quantity,
    held: Quantity,
}

impl Balance {
    const fn fresh(window: WindowId) -> Self {
        Self {
            window,
            spent: Quantity::ZERO,
            held: Quantity::ZERO,
        }
    }
}

fn held_overflowed(key: &BudgetKey) -> BudgetError {
    BudgetError::Invariant(format!("held total for {key} overflowed"))
}

/// Metered spending against one set of [`Limits`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetLedger {
    limits: Limits,
    version: u64,
    observed_now: DateTime<Utc>,
    buckets: BTreeMap<BudgetKey, Balance>,
    open: BTreeMap<ReservationId, Reservation>,
    closed: BTreeMap<ReservationId, SettlementReceipt>,
}

impl BudgetLedger {
    /// An untouched ledger. `opened_at` seeds the observed clock, so an earlier
    /// instant offered later is a [`BudgetError::ClockRegression`].
    #[must_use]
    pub fn new(limits: Limits, opened_at: DateTime<Utc>) -> Self {
        Self {
            limits,
            version: 0,
            observed_now: opened_at,
            buckets: BTreeMap::new(),
            open: BTreeMap::new(),
            closed: BTreeMap::new(),
        }
    }

    #[must_use]
    pub const fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Committed caller operations so far. The compare-and-set token.
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    #[must_use]
    pub const fn observed_now(&self) -> DateTime<Utc> {
        self.observed_now
    }

    #[must_use]
    pub fn reservation(&self, id: &ReservationId) -> Option<&Reservation> {
        self.open.get(id)
    }

    #[must_use]
    pub fn receipt(&self, id: &ReservationId) -> Option<&SettlementReceipt> {
        self.closed.get(id)
    }

    #[must_use]
    pub fn open_holds(&self) -> usize {
        self.open.len()
    }

    /// # Errors
    ///
    /// Returns [`BudgetError::VersionConflict`] when the ledger has moved on.
    pub fn assert_version(&self, expected: u64) -> Result<(), BudgetError> {
        if self.version == expected {
            return Ok(());
        }
        Err(BudgetError::VersionConflict {
            expected,
            actual: self.version,
        })
    }

    /// One bucket as it stands at `now`, without mutating anything.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::UnknownKey`] for a dimension these limits do not
    /// meter.
    pub fn reading(
        &self,
        key: &BudgetKey,
        now: DateTime<Utc>,
    ) -> Result<MeterReading, BudgetError> {
        let limit = self.limit_for(key)?;
        Ok(self.project(key, limit, now))
    }

    /// Every metered bucket at `now`, in key order.
    #[must_use]
    pub fn readings(&self, now: DateTime<Utc>) -> Vec<MeterReading> {
        self.limits
            .iter()
            .map(|(key, limit)| self.project(key, limit, now))
            .collect()
    }

    fn limit_for(&self, key: &BudgetKey) -> Result<&Limit, BudgetError> {
        self.limits
            .get(key)
            .ok_or_else(|| BudgetError::UnknownKey(key.to_string()))
    }

    /// A bucket's totals as of `now`, without mutating anything.
    ///
    /// Two things are projected rather than stored, and both are why a reading
    /// taken before an operation agrees with what that operation will do:
    ///
    /// - A balance from a **closed window** reads as fresh. This is where a
    ///   refill happens: no reset is ever written, the stale balance simply
    ///   stops counting. A ledger that zeroed buckets on a timer would need that
    ///   timer to have run before it could answer correctly.
    /// - A **lapsed hold** is not counted as held. Its quantity is already back
    ///   in the pool as far as the next [`BudgetLedger::tick`] is concerned, and
    ///   a reading that still counted it would refuse a request the very next
    ///   operation admits.
    fn project(&self, key: &BudgetKey, limit: &Limit, now: DateTime<Utc>) -> MeterReading {
        let window = limit.window().window_at(now);
        let (spent, held) = self
            .buckets
            .get(key)
            .filter(|balance| balance.window == window)
            .map_or((Quantity::ZERO, Quantity::ZERO), |balance| {
                (balance.spent, balance.held)
            });
        MeterReading::new(
            key.clone(),
            limit.unit().clone(),
            window,
            limit.cap(),
            spent,
            held.saturating_sub(self.lapsed_held(key, window, now)),
        )
    }

    /// Quantity held against `key` in `window` by reservations whose deadline has
    /// already passed at `now`.
    fn lapsed_held(&self, key: &BudgetKey, window: WindowId, now: DateTime<Utc>) -> Quantity {
        let total = self
            .open
            .values()
            .filter(|reservation| reservation.has_lapsed_at(now))
            .filter_map(|reservation| reservation.hold(key))
            .filter(|hold| hold.window() == window)
            .fold(0_u128, |sum, hold| {
                sum.saturating_add(hold.quantity().minor_units())
            });
        Quantity::from_minor_units(total)
    }

    /// Advance the observed clock, expire lapsed holds, drop closed windows.
    ///
    /// Every operation begins here, so no caller acts on a state that time has
    /// already invalidated.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::ClockRegression`] when `now` precedes the last
    /// instant observed — accepting it would resurrect an elapsed window or an
    /// expired hold — or [`BudgetError::Invariant`] if returning a lapsed hold
    /// finds the ledger inconsistent.
    pub fn tick(&mut self, now: DateTime<Utc>) -> Result<(), BudgetError> {
        if now < self.observed_now {
            return Err(BudgetError::ClockRegression {
                observed: self.observed_now.to_rfc3339(),
                offered: now.to_rfc3339(),
            });
        }
        self.observed_now = now;
        self.expire_lapsed(now)?;
        self.roll_windows(now)
    }

    fn expire_lapsed(&mut self, now: DateTime<Utc>) -> Result<(), BudgetError> {
        let lapsed: Vec<ReservationId> = self
            .open
            .iter()
            .filter(|(_, reservation)| reservation.has_lapsed_at(now))
            .map(|(id, _)| id.clone())
            .collect();
        for id in lapsed {
            let reservation = self.open.remove(&id).ok_or_else(|| {
                BudgetError::Invariant(format!("hold {id} vanished while expiring"))
            })?;
            self.return_holds(&reservation)?;
            self.closed.insert(
                id.clone(),
                SettlementReceipt::new(
                    id,
                    ReservationOutcome::Expired,
                    BTreeMap::new(),
                    now,
                    self.version,
                ),
            );
        }
        Ok(())
    }

    fn roll_windows(&mut self, now: DateTime<Utc>) -> Result<(), BudgetError> {
        let stale: Vec<BudgetKey> = self
            .buckets
            .iter()
            .filter(|(key, balance)| {
                self.limits
                    .get(key)
                    .is_none_or(|limit| limit.window().window_at(now) != balance.window)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            let Some(balance) = self.buckets.remove(&key) else {
                continue;
            };
            // expire_lapsed ran first and no hold outlives its window, so a
            // closed window cannot still owe anything. Checked, not assumed.
            if !balance.held.is_zero() {
                return Err(BudgetError::Invariant(format!(
                    "window closed on {key} while {} was still held",
                    balance.held
                )));
            }
        }
        Ok(())
    }

    /// Return every hold of `reservation` to its bucket's available pool.
    fn return_holds(&mut self, reservation: &Reservation) -> Result<(), BudgetError> {
        for (key, hold) in reservation.holds() {
            let balance = self
                .buckets
                .get_mut(key)
                .ok_or_else(|| BudgetError::Invariant(format!("no bucket holds {key}")))?;
            if balance.window != hold.window() {
                return Err(BudgetError::Invariant(format!(
                    "hold on {key} is charged to a window the bucket no longer tracks"
                )));
            }
            balance.held = balance.held.checked_sub(hold.quantity()).map_err(|_| {
                BudgetError::Invariant(format!("held total for {key} is below the hold returned"))
            })?;
        }
        Ok(())
    }

    fn bump_version(&mut self) -> Result<u64, BudgetError> {
        self.version = self
            .version
            .checked_add(1)
            .ok_or_else(|| BudgetError::Invariant("ledger version space exhausted".to_string()))?;
        Ok(self.version)
    }

    /// Held quantity per key, summed over every open reservation. The figure each
    /// bucket's own `held` total must equal.
    fn open_hold_totals(&self) -> Result<BTreeMap<&BudgetKey, u128>, BudgetError> {
        let mut totals: BTreeMap<&BudgetKey, u128> = BTreeMap::new();
        let holds = self
            .open
            .values()
            .flat_map(|reservation| reservation.holds().iter());
        for (key, hold) in holds {
            let running = totals.entry(key).or_insert(0);
            *running = running
                .checked_add(hold.quantity().minor_units())
                .ok_or_else(|| held_overflowed(key))?;
        }
        Ok(totals)
    }

    /// Verify conservation: nothing over cap, and every held unit belongs to an
    /// open hold.
    ///
    /// The second half is the one that matters. An over-cap bucket would have to
    /// get past an admission check, but a *leaked* hold — held quantity with no
    /// reservation behind it, or a reservation whose hold was never recorded —
    /// permanently shrinks the root's capacity, and no single operation looks
    /// wrong at the moment it happens.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::Invariant`] naming the first breach found.
    pub fn assert_conserved(&self) -> Result<(), BudgetError> {
        let mut expected = self.open_hold_totals()?;
        for (key, balance) in &self.buckets {
            let limit = self.limits.get(key).ok_or_else(|| {
                BudgetError::Invariant(format!("bucket {key} has no limit behind it"))
            })?;
            let committed = balance.spent.checked_add(balance.held)?;
            if committed > limit.cap() {
                return Err(BudgetError::Invariant(format!(
                    "{key} has committed {committed} over a cap of {}",
                    limit.cap()
                )));
            }
            let accounted = expected.remove(key).unwrap_or(0);
            if balance.held.minor_units() != accounted {
                return Err(BudgetError::Invariant(format!(
                    "{key} holds {} but open reservations account for {accounted}",
                    balance.held
                )));
            }
        }
        if let Some((key, amount)) = expected.into_iter().next() {
            return Err(BudgetError::Invariant(format!(
                "{key} has {amount} held by open reservations but no bucket"
            )));
        }
        Ok(())
    }
}
