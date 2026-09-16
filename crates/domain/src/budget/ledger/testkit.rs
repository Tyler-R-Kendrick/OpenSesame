//! Shared fixtures for the ledger's own tests.
//!
//! Every helper here fixes one degree of freedom so the tests can vary the one
//! they are actually about: a single `calls` dimension, whole counts, and an
//! instant the caller names.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};

use super::BudgetLedger;
use crate::budget::fixtures::{at, calls_limits, key};
use crate::budget::{Amount, BudgetKey, ReservationId, SpendRequest, WindowSpec};

pub fn id(raw: &str) -> ReservationId {
    ReservationId::parse(raw).expect("valid reservation id")
}

/// A one-dimension request for `calls` whole units, holding for `hold_seconds`.
pub fn request(raw: &str, calls: u128, hold_seconds: u32) -> SpendRequest {
    SpendRequest::new(id(raw), hold_seconds)
        .expect("valid hold")
        .spending(key("calls"), Amount::count(calls))
        .expect("one key")
}

/// A ledger metering `calls` at `cap` per `window`, opened at the epoch.
pub fn ledger(cap: u128, window: WindowSpec) -> BudgetLedger {
    BudgetLedger::new(calls_limits(cap, window), at(0))
}

/// Minor units settled against `calls` as of `now`.
pub fn spent(ledger: &BudgetLedger, now: DateTime<Utc>) -> u128 {
    ledger
        .reading(&key("calls"), now)
        .expect("calls is metered")
        .spent()
        .minor_units()
}

/// A settlement report naming `calls` and nothing else.
pub fn usage(calls: u128) -> BTreeMap<BudgetKey, Amount> {
    [(key("calls"), Amount::count(calls))].into_iter().collect()
}
