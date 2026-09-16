//! How a hold ended, and the record that proves it.
//!
//! A [`SettlementReceipt`] outlives the hold it closes. That is the whole point:
//! once the quantity has moved, a retry of the settle that moved it must be
//! answerable with *what happened* rather than performed again. Without a
//! durable record, "did my settle land?" has no safe answer, and every timeout
//! becomes a choice between losing a spend and doubling one.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{Amount, BudgetKey, ReservationId};

/// How a reservation ended. Every open hold reaches exactly one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationOutcome {
    /// The caller reported what it used; that much is now spent.
    Settled,
    /// The caller gave the hold back unspent.
    Released,
    /// The deadline passed first. The quantity returned to the pool and may
    /// already have been spent by somebody else, so a later settle is refused
    /// rather than applied to whatever is left.
    Expired,
}

impl ReservationOutcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Released => "released",
            Self::Expired => "expired",
        }
    }

    /// Whether the held quantity went back to the pool unspent.
    #[must_use]
    pub const fn returned_to_pool(self) -> bool {
        matches!(self, Self::Released | Self::Expired)
    }
}

/// The durable record of a closed reservation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettlementReceipt {
    id: ReservationId,
    outcome: ReservationOutcome,
    settled: BTreeMap<BudgetKey, Amount>,
    at: DateTime<Utc>,
    version: u64,
}

impl SettlementReceipt {
    #[must_use]
    pub const fn new(
        id: ReservationId,
        outcome: ReservationOutcome,
        settled: BTreeMap<BudgetKey, Amount>,
        at: DateTime<Utc>,
        version: u64,
    ) -> Self {
        Self {
            id,
            outcome,
            settled,
            at,
            version,
        }
    }

    #[must_use]
    pub const fn id(&self) -> &ReservationId {
        &self.id
    }

    #[must_use]
    pub const fn outcome(&self) -> ReservationOutcome {
        self.outcome
    }

    /// What was recorded as spent, one entry per dimension the hold covered —
    /// zero included, so a receipt names every key it could have charged and a
    /// reader never has to guess whether a missing key meant nothing or means
    /// the receipt is incomplete.
    #[must_use]
    pub const fn settled(&self) -> &BTreeMap<BudgetKey, Amount> {
        &self.settled
    }

    #[must_use]
    pub const fn at(&self) -> DateTime<Utc> {
        self.at
    }

    /// The ledger version this receipt was written at.
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    /// Total recorded against one dimension, or `None` if it was not covered.
    #[must_use]
    pub fn spent_on(&self, key: &BudgetKey) -> Option<&Amount> {
        self.settled.get(key)
    }

    /// Whether a replayed settle reports the same usage this receipt recorded.
    ///
    /// A key the caller omits is zero, which is how the ledger normalized it on
    /// the way in, so `{}` and `{calls: 0}` are the same report. A key the
    /// receipt never covered is never a match, even at zero: it means the caller
    /// and the ledger disagree about which hold this is.
    #[must_use]
    pub fn reports(&self, actual: &BTreeMap<BudgetKey, Amount>) -> bool {
        let all_keys_known = actual.keys().all(|key| self.settled.contains_key(key));
        all_keys_known
            && self
                .settled
                .iter()
                .all(|(key, recorded)| match actual.get(key) {
                    Some(offered) => offered == recorded,
                    None => recorded.quantity().is_zero(),
                })
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{at, key};
    use super::*;

    fn receipt(outcome: ReservationOutcome, settled: Vec<(&str, u128)>) -> SettlementReceipt {
        SettlementReceipt::new(
            ReservationId::parse("res-1").expect("valid id"),
            outcome,
            settled
                .into_iter()
                .map(|(raw, units)| (key(raw), Amount::count(units)))
                .collect(),
            at(0),
            1,
        )
    }

    #[test]
    fn an_unnamed_key_reads_as_zero() {
        let settled = receipt(ReservationOutcome::Settled, vec![("calls", 0)]);
        assert!(settled.reports(&BTreeMap::new()));
        assert!(settled.reports(&[(key("calls"), Amount::count(0))].into_iter().collect()));
        assert!(!settled.reports(&[(key("calls"), Amount::count(1))].into_iter().collect()));
    }

    #[test]
    fn a_key_the_receipt_never_covered_is_never_a_match() {
        let settled = receipt(ReservationOutcome::Settled, vec![("calls", 2)]);
        assert!(!settled.reports(&[(key("usd"), Amount::count(0))].into_iter().collect()));
        assert!(settled.reports(&[(key("calls"), Amount::count(2))].into_iter().collect()));
    }

    #[test]
    fn a_replay_must_agree_on_every_dimension() {
        let settled = receipt(ReservationOutcome::Settled, vec![("calls", 2), ("usd", 5)]);
        let partial: BTreeMap<_, _> = [(key("calls"), Amount::count(2))].into_iter().collect();
        assert!(
            !settled.reports(&partial),
            "omitting a non-zero dimension is a different report"
        );
        let whole: BTreeMap<_, _> = [
            (key("calls"), Amount::count(2)),
            (key("usd"), Amount::count(5)),
        ]
        .into_iter()
        .collect();
        assert!(settled.reports(&whole));
    }

    #[test]
    fn only_release_and_expiry_return_the_hold() {
        assert!(ReservationOutcome::Released.returned_to_pool());
        assert!(ReservationOutcome::Expired.returned_to_pool());
        assert!(!ReservationOutcome::Settled.returned_to_pool());
    }

    #[test]
    fn a_receipt_names_what_it_charged() {
        let settled = receipt(ReservationOutcome::Settled, vec![("calls", 2)]);
        assert_eq!(
            settled.spent_on(&key("calls")).map(Amount::quantity),
            Some(super::super::Quantity::from_minor_units(2))
        );
        assert_eq!(settled.spent_on(&key("usd")), None);
        assert_eq!(settled.outcome().as_str(), "settled");
        assert_eq!(settled.version(), 1);
        assert_eq!(settled.at(), at(0));
    }
}
