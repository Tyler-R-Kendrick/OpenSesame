//! Reserve, settle, release — the operations that move quantity.
//!
//! Every one of them is **all-or-nothing across dimensions** and **idempotent by
//! [`ReservationId`]**, and those two properties are what the rest of the module
//! is arranged to support.
//!
//! All-or-nothing matters because a consumer needing both an invocation and a
//! dollar must not end up holding the invocation after the dollar was refused;
//! that hold would be capacity nobody can account for and nobody will settle.
//! So each operation *plans* against every dimension first and mutates only once
//! the whole plan is known to fit.
//!
//! Idempotency matters because the network between a consumer and a ledger can
//! lose a response but not the spend behind it. A retry therefore has to be
//! answerable: an open hold under the same id and the same request is returned
//! as-is, and a closed one is answered from its receipt. An id is single-use, so
//! the one thing a retry can never do is open a second hold.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};

use super::{Balance, BudgetLedger};
use crate::budget::{
    Amount, BudgetError, BudgetKey, Hold, Quantity, Reservation, ReservationId, ReservationOutcome,
    SettlementReceipt, SpendRequest,
};

/// What one settlement does to one bucket, computed before anything is mutated.
struct Change {
    released: Quantity,
    recorded: Quantity,
    amount: Amount,
}

impl BudgetLedger {
    /// Take a hold covering every dimension of `request`, or none of them.
    ///
    /// Idempotent by [`SpendRequest::id`]: a replay asking for the same thing
    /// returns the hold already open and does not advance the version.
    ///
    /// # Errors
    ///
    /// - [`BudgetError::ClockRegression`] if `now` went backwards.
    /// - [`BudgetError::ReplayMismatch`] if the id is in use for a different
    ///   request, or was already closed — an id is single-use, because
    ///   re-opening a spent one is the double-spend idempotency exists to stop.
    /// - [`BudgetError::EmptyRequest`] for a request naming no dimension.
    /// - [`BudgetError::UnknownKey`] for a dimension these limits do not meter.
    /// - [`BudgetError::UnitMismatch`] if an amount is denominated differently
    ///   from its limit.
    /// - [`BudgetError::LimitExceeded`] if any dimension does not fit, in which
    ///   case nothing is held at all.
    pub fn reserve(
        &mut self,
        request: &SpendRequest,
        now: DateTime<Utc>,
    ) -> Result<Reservation, BudgetError> {
        self.tick(now)?;
        if let Some(existing) = self.open.get(request.id()) {
            if existing.answers(request) {
                return Ok(existing.clone());
            }
            return Err(BudgetError::ReplayMismatch {
                id: request.id().to_string(),
                detail: "an open hold under this id covers a different request".to_string(),
            });
        }
        if let Some(receipt) = self.closed.get(request.id()) {
            return Err(BudgetError::ReplayMismatch {
                id: request.id().to_string(),
                detail: format!(
                    "this id was already {} and an id is single-use",
                    receipt.outcome().as_str()
                ),
            });
        }
        if request.is_empty() {
            return Err(BudgetError::EmptyRequest);
        }
        let (holds, expires_at) = self.plan(request, now)?;
        for (key, hold) in &holds {
            let balance = self
                .buckets
                .entry(key.clone())
                .or_insert_with(|| Balance::fresh(hold.window()));
            balance.held = balance.held.checked_add(hold.quantity())?;
        }
        let reservation = Reservation::new(
            request.id().clone(),
            holds,
            request.clone(),
            now,
            expires_at,
        );
        self.open.insert(request.id().clone(), reservation.clone());
        self.bump_version()?;
        Ok(reservation)
    }

    /// [`BudgetLedger::reserve`], but only if nobody has committed since
    /// `expected_version`. The compare-and-set half of an optimistic retry loop.
    ///
    /// # Errors
    ///
    /// [`BudgetError::VersionConflict`] before any of [`BudgetLedger::reserve`]'s
    /// own refusals.
    pub fn reserve_expecting(
        &mut self,
        expected_version: u64,
        request: &SpendRequest,
        now: DateTime<Utc>,
    ) -> Result<Reservation, BudgetError> {
        self.assert_version(expected_version)?;
        self.reserve(request, now)
    }

    /// Validate every dimension before committing any, and shorten the deadline
    /// to the earliest window end involved.
    fn plan(
        &self,
        request: &SpendRequest,
        now: DateTime<Utc>,
    ) -> Result<(BTreeMap<BudgetKey, Hold>, DateTime<Utc>), BudgetError> {
        let mut holds = BTreeMap::new();
        let mut expires_at = request.requested_expiry(now);
        for (key, amount) in request.amounts() {
            let limit = self.limit_for(key)?;
            let wanted = amount.quantity_in(limit.unit(), key)?;
            let reading = self.project(key, limit, now);
            if !reading.admits(wanted) {
                return Err(BudgetError::LimitExceeded {
                    key: key.to_string(),
                    requested: wanted.to_decimal_string(limit.unit()),
                    available: reading.available().to_decimal_string(limit.unit()),
                });
            }
            // A hold may not outlive the allowance it spends from.
            if let Some(end) = reading.window().ends_at() {
                expires_at = expires_at.min(end);
            }
            holds.insert(key.clone(), Hold::new(amount.clone(), reading.window()));
        }
        Ok((holds, expires_at))
    }

    /// Record what was actually used and give the rest back.
    ///
    /// A dimension the caller omits settles at zero. Actual usage may be less
    /// than the hold (the difference returns to the pool) or more (the overage
    /// must still fit under the cap, or the whole settlement is refused and the
    /// hold stays open for the caller to release).
    ///
    /// Idempotent: a replay reporting the same usage returns the same receipt.
    ///
    /// # Errors
    ///
    /// - [`BudgetError::ReservationExpired`] if the hold lapsed first; its
    ///   quantity returned to the pool and may already have been spent.
    /// - [`BudgetError::UnknownReservation`] if no such hold is open.
    /// - [`BudgetError::ReplayMismatch`] for a second, different report.
    /// - [`BudgetError::UnknownKey`] for usage on a dimension never held.
    /// - [`BudgetError::UnitMismatch`], [`BudgetError::LimitExceeded`] and
    ///   [`BudgetError::ClockRegression`] as in [`BudgetLedger::reserve`].
    pub fn settle(
        &mut self,
        id: &ReservationId,
        actual: &BTreeMap<BudgetKey, Amount>,
        now: DateTime<Utc>,
    ) -> Result<SettlementReceipt, BudgetError> {
        self.tick(now)?;
        if let Some(receipt) = self.closed.get(id) {
            return match receipt.outcome() {
                ReservationOutcome::Settled if receipt.reports(actual) => Ok(receipt.clone()),
                ReservationOutcome::Expired => Err(BudgetError::ReservationExpired(id.to_string())),
                other => Err(BudgetError::ReplayMismatch {
                    id: id.to_string(),
                    detail: format!("already {} under a different report", other.as_str()),
                }),
            };
        }
        let reservation = self
            .open
            .get(id)
            .ok_or_else(|| BudgetError::UnknownReservation(id.to_string()))?
            .clone();
        let plan = self.plan_settlement(&reservation, actual)?;
        for (key, change) in &plan {
            let balance = self
                .buckets
                .get_mut(key)
                .ok_or_else(|| BudgetError::Invariant(format!("no bucket holds {key}")))?;
            balance.held = balance.held.checked_sub(change.released).map_err(|_| {
                BudgetError::Invariant(format!("held total for {key} is below the hold settled"))
            })?;
            balance.spent = balance.spent.checked_add(change.recorded)?;
        }
        self.open.remove(id);
        let version = self.bump_version()?;
        let settled = plan
            .into_iter()
            .map(|(key, change)| (key, change.amount))
            .collect();
        let receipt = SettlementReceipt::new(
            id.clone(),
            ReservationOutcome::Settled,
            settled,
            now,
            version,
        );
        self.closed.insert(id.clone(), receipt.clone());
        Ok(receipt)
    }

    /// Settle for exactly what was held — the common case, and the one a caller
    /// cannot get wrong by restating amounts.
    ///
    /// # Errors
    ///
    /// As [`BudgetLedger::settle`], plus [`BudgetError::UnknownReservation`] if
    /// no hold is open under `id`.
    pub fn settle_in_full(
        &mut self,
        id: &ReservationId,
        now: DateTime<Utc>,
    ) -> Result<SettlementReceipt, BudgetError> {
        let actual = self
            .open
            .get(id)
            .ok_or_else(|| BudgetError::UnknownReservation(id.to_string()))?
            .holds()
            .iter()
            .map(|(key, hold)| (key.clone(), hold.amount().clone()))
            .collect();
        self.settle(id, &actual, now)
    }

    /// Work out each bucket's movement, refusing before anything is mutated.
    fn plan_settlement(
        &self,
        reservation: &Reservation,
        actual: &BTreeMap<BudgetKey, Amount>,
    ) -> Result<BTreeMap<BudgetKey, Change>, BudgetError> {
        for key in actual.keys() {
            if reservation.hold(key).is_none() {
                return Err(BudgetError::UnknownKey(key.to_string()));
            }
        }
        let mut plan = BTreeMap::new();
        for (key, hold) in reservation.holds() {
            let limit = self
                .limits
                .get(key)
                .ok_or_else(|| BudgetError::Invariant(format!("held key {key} is unmetered")))?;
            let released = hold.quantity();
            let amount = actual
                .get(key)
                .cloned()
                .unwrap_or_else(|| Amount::new(Quantity::ZERO, limit.unit().clone()));
            let recorded = amount.quantity_in(limit.unit(), key)?;
            let balance = self
                .buckets
                .get(key)
                .ok_or_else(|| BudgetError::Invariant(format!("no bucket holds {key}")))?;
            if balance.window != hold.window() {
                return Err(BudgetError::Invariant(format!(
                    "hold on {key} is charged to a window the bucket no longer tracks"
                )));
            }
            let others_held = balance.held.checked_sub(released).map_err(|_| {
                BudgetError::Invariant(format!("held total for {key} is below this hold"))
            })?;
            let without_this_hold = balance.spent.checked_add(others_held)?;
            if without_this_hold.checked_add(recorded)? > limit.cap() {
                return Err(BudgetError::LimitExceeded {
                    key: key.to_string(),
                    requested: recorded.to_decimal_string(limit.unit()),
                    available: limit
                        .cap()
                        .saturating_sub(without_this_hold)
                        .to_decimal_string(limit.unit()),
                });
            }
            plan.insert(
                key.clone(),
                Change {
                    released,
                    recorded,
                    amount,
                },
            );
        }
        Ok(plan)
    }

    /// Give the hold back unspent.
    ///
    /// Idempotent, and a hold that already expired counts as released: the
    /// quantity is back in the pool either way, which is what the caller asked
    /// for.
    ///
    /// # Errors
    ///
    /// [`BudgetError::UnknownReservation`] if no such hold exists, or
    /// [`BudgetError::ReplayMismatch`] if it was settled — a recorded spend
    /// cannot be taken back.
    pub fn release(
        &mut self,
        id: &ReservationId,
        now: DateTime<Utc>,
    ) -> Result<SettlementReceipt, BudgetError> {
        self.tick(now)?;
        if let Some(receipt) = self.closed.get(id) {
            return match receipt.outcome() {
                ReservationOutcome::Released | ReservationOutcome::Expired => Ok(receipt.clone()),
                ReservationOutcome::Settled => Err(BudgetError::ReplayMismatch {
                    id: id.to_string(),
                    detail: "already settled; a recorded spend cannot be released".to_string(),
                }),
            };
        }
        let reservation = self
            .open
            .get(id)
            .ok_or_else(|| BudgetError::UnknownReservation(id.to_string()))?
            .clone();
        self.return_holds(&reservation)?;
        self.open.remove(id);
        let version = self.bump_version()?;
        let receipt = SettlementReceipt::new(
            id.clone(),
            ReservationOutcome::Released,
            BTreeMap::new(),
            now,
            version,
        );
        self.closed.insert(id.clone(), receipt.clone());
        Ok(receipt)
    }
}
