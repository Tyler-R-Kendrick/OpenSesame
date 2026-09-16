//! Two-phase spending: the request and the hold (BUD-RESERVE).
//!
//! Nothing is deducted on the strength of an intention. A caller *reserves*,
//! which moves quantity from available to held; does the work; then *settles*
//! the amount actually used, or *releases* the hold. Both phases are named by
//! the caller's own [`ReservationId`], which is why a retry after a timeout is
//! safe: the second attempt finds the first one's hold and returns it instead of
//! opening another.
//!
//! A hold is therefore a liability with a deadline, and the deadline is the
//! reason a crashed consumer cannot strand a root's capacity. Two rules bound
//! it: a caller may not ask for a hold longer than [`MAX_HOLD_SECONDS`], and
//! [`super::BudgetLedger`] shortens any hold that would outlive the window it
//! spends from — a spend cannot be recorded against an allowance that has
//! already closed and refilled.

use std::collections::BTreeMap;
use std::fmt;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::{Amount, BudgetError, BudgetKey, Quantity, WindowId};

/// Longest hold a caller may ask for: one hour.
///
/// A hold is capacity nobody else may spend, so its length is the window during
/// which one stuck consumer degrades everyone else. An hour is generous for any
/// single invocation and short enough that a crash is self-healing.
pub const MAX_HOLD_SECONDS: u32 = 3_600;

/// Longest reservation id accepted.
const MAX_ID: usize = 128;

/// The caller's name for one reservation, and its idempotency key.
///
/// Supplied by the caller rather than minted here on purpose: an id the ledger
/// invented would be lost along with the response that carried it, and a retry
/// could not name the hold it was trying to find again.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ReservationId(String);

impl ReservationId {
    /// # Errors
    ///
    /// Returns [`BudgetError::InvalidKey`] when the id is empty, longer than
    /// 128 bytes, or contains anything but printable ASCII — the same bound
    /// [`BudgetKey`] uses, so an id can never be confused with another one in a
    /// log line or a persisted map.
    pub fn parse(raw: &str) -> Result<Self, BudgetError> {
        if raw.is_empty() || raw.len() > MAX_ID || !raw.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(BudgetError::InvalidKey(raw.to_string()));
        }
        Ok(Self(raw.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ReservationId {
    type Error = BudgetError;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

impl From<ReservationId> for String {
    fn from(id: ReservationId) -> Self {
        id.0
    }
}

impl fmt::Display for ReservationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a caller is about to spend, across every dimension at once.
///
/// One request covers all keys deliberately: a consumer that needed both an
/// invocation and a dollar would otherwise take them in two steps and could hold
/// the first while failing the second, stranding capacity nobody can account
/// for. [`super::BudgetLedger::reserve`] admits a request whole or not at all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendRequest {
    id: ReservationId,
    amounts: BTreeMap<BudgetKey, Amount>,
    hold_seconds: u32,
}

impl SpendRequest {
    /// An empty request holding for `hold_seconds`.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::InvalidLimit`] for a zero hold — which would
    /// expire before the work it covers — or one over [`MAX_HOLD_SECONDS`].
    pub fn new(id: ReservationId, hold_seconds: u32) -> Result<Self, BudgetError> {
        if hold_seconds == 0 || hold_seconds > MAX_HOLD_SECONDS {
            return Err(BudgetError::InvalidLimit {
                key: id.to_string(),
                detail: format!("a hold of {hold_seconds}s is outside 1..={MAX_HOLD_SECONDS}s"),
            });
        }
        Ok(Self {
            id,
            amounts: BTreeMap::new(),
            hold_seconds,
        })
    }

    /// Add one dimension to the request.
    ///
    /// # Errors
    ///
    /// Returns [`BudgetError::DuplicateKey`] when the key is already present.
    /// Silently keeping the larger of two amounts would spend more than the
    /// caller wrote down; keeping the later would spend less.
    pub fn spending(mut self, key: BudgetKey, amount: Amount) -> Result<Self, BudgetError> {
        if self.amounts.contains_key(&key) {
            return Err(BudgetError::DuplicateKey(key.to_string()));
        }
        self.amounts.insert(key, amount);
        Ok(self)
    }

    #[must_use]
    pub const fn id(&self) -> &ReservationId {
        &self.id
    }

    #[must_use]
    pub const fn hold_seconds(&self) -> u32 {
        self.hold_seconds
    }

    pub fn amounts(&self) -> impl Iterator<Item = (&BudgetKey, &Amount)> {
        self.amounts.iter()
    }

    #[must_use]
    pub fn amount(&self, key: &BudgetKey) -> Option<&Amount> {
        self.amounts.get(key)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.amounts.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.amounts.len()
    }

    /// When this hold would lapse if no window closed first. The ledger takes
    /// the earlier of this and the end of each window being spent from.
    #[must_use]
    pub fn requested_expiry(&self, opened_at: DateTime<Utc>) -> DateTime<Utc> {
        opened_at + Duration::seconds(i64::from(self.hold_seconds))
    }

    /// Whether a replayed request is the same request.
    #[must_use]
    pub fn matches(&self, other: &Self) -> bool {
        self.amounts == other.amounts && self.hold_seconds == other.hold_seconds
    }
}

/// One dimension of an open hold: the quantity, and the window it is charged to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    amount: Amount,
    window: WindowId,
}

impl Hold {
    #[must_use]
    pub const fn new(amount: Amount, window: WindowId) -> Self {
        Self { amount, window }
    }

    #[must_use]
    pub const fn amount(&self) -> &Amount {
        &self.amount
    }

    /// The window this hold is charged to — the one that was open when it was
    /// taken, not whichever is open when it settles.
    #[must_use]
    pub const fn window(&self) -> WindowId {
        self.window
    }

    #[must_use]
    pub const fn quantity(&self) -> Quantity {
        self.amount.quantity()
    }
}

/// An open hold: quantity taken out of availability, not yet spent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reservation {
    id: ReservationId,
    holds: BTreeMap<BudgetKey, Hold>,
    request: SpendRequest,
    opened_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

impl Reservation {
    #[must_use]
    pub const fn new(
        id: ReservationId,
        holds: BTreeMap<BudgetKey, Hold>,
        request: SpendRequest,
        opened_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            holds,
            request,
            opened_at,
            expires_at,
        }
    }

    #[must_use]
    pub const fn id(&self) -> &ReservationId {
        &self.id
    }

    #[must_use]
    pub const fn holds(&self) -> &BTreeMap<BudgetKey, Hold> {
        &self.holds
    }

    #[must_use]
    pub fn hold(&self, key: &BudgetKey) -> Option<&Hold> {
        self.holds.get(key)
    }

    #[must_use]
    pub const fn opened_at(&self) -> DateTime<Utc> {
        self.opened_at
    }

    /// The effective deadline, already shortened to the end of the earliest
    /// window this reservation spends from.
    #[must_use]
    pub const fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    /// The deadline has passed at `now`.
    ///
    /// Inclusive: a hold that expires *at* an instant is not available at that
    /// instant. The alternative leaves a one-tick window in which a lapsed hold
    /// and whatever replaced it are both charged.
    #[must_use]
    pub fn has_lapsed_at(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// Whether a replayed reserve names the same request as the one that opened
    /// this hold.
    #[must_use]
    pub fn answers(&self, request: &SpendRequest) -> bool {
        self.request.matches(request)
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{at, hourly, key};
    use super::*;

    fn request(hold_seconds: u32) -> SpendRequest {
        SpendRequest::new(
            ReservationId::parse("res-1").expect("valid id"),
            hold_seconds,
        )
        .expect("valid hold")
        .spending(key("calls"), Amount::count(2))
        .expect("first key")
    }

    #[test]
    fn a_hold_must_have_a_usable_length() {
        let id = ReservationId::parse("res-1").unwrap();
        assert!(matches!(
            SpendRequest::new(id.clone(), 0),
            Err(BudgetError::InvalidLimit { .. })
        ));
        assert!(matches!(
            SpendRequest::new(id.clone(), MAX_HOLD_SECONDS + 1),
            Err(BudgetError::InvalidLimit { .. })
        ));
        assert!(SpendRequest::new(id, MAX_HOLD_SECONDS).is_ok());
    }

    #[test]
    fn a_dimension_cannot_be_named_twice() {
        assert!(matches!(
            request(60).spending(key("calls"), Amount::count(5)),
            Err(BudgetError::DuplicateKey(_))
        ));
    }

    #[test]
    fn a_replay_is_only_a_replay_if_it_asks_for_the_same_thing() {
        let original = request(60);
        assert!(original.matches(&request(60)));
        assert!(
            !original.matches(&request(120)),
            "a different hold length is a different request"
        );
        let bigger = SpendRequest::new(ReservationId::parse("res-1").unwrap(), 60)
            .unwrap()
            .spending(key("calls"), Amount::count(3))
            .unwrap();
        assert!(!original.matches(&bigger));
        assert_eq!(original.len(), 1);
        assert!(!original.is_empty());
        assert_eq!(original.amount(&key("calls")), Some(&Amount::count(2)));
        assert_eq!(original.amount(&key("usd")), None);
        assert_eq!(original.hold_seconds(), 60);
        assert_eq!(original.requested_expiry(at(0)), at(60));
    }

    #[test]
    fn a_hold_lapses_at_its_deadline_not_after_it() {
        let holds = [(
            key("calls"),
            Hold::new(Amount::count(2), WindowId::Lifetime),
        )]
        .into_iter()
        .collect();
        let reservation =
            Reservation::new(request(60).id().clone(), holds, request(60), at(0), at(60));
        assert!(!reservation.has_lapsed_at(at(59)));
        assert!(reservation.has_lapsed_at(at(60)));
        assert!(reservation.has_lapsed_at(at(61)));
        assert_eq!(reservation.opened_at(), at(0));
        assert_eq!(reservation.expires_at(), at(60));
        assert!(reservation.answers(&request(60)));
        assert_eq!(reservation.holds().len(), 1);
        assert!(reservation.hold(&key("usd")).is_none());
    }

    #[test]
    fn a_hold_remembers_the_window_it_was_taken_in() {
        let window = hourly().window_at(at(0));
        let hold = Hold::new(Amount::count(3), window);
        assert_eq!(hold.window(), window);
        assert_eq!(hold.quantity(), Quantity::from_minor_units(3));
        assert_eq!(hold.amount(), &Amount::count(3));
    }

    #[test]
    fn ids_are_bounded_and_unambiguous() {
        assert_eq!(ReservationId::parse("res-1").unwrap().as_str(), "res-1");
        for raw in ["", "res 1", "res\n1", "\u{e9}"] {
            assert!(
                ReservationId::parse(raw).is_err(),
                "{raw:?} must be refused"
            );
        }
        assert!(ReservationId::parse(&"r".repeat(MAX_ID + 1)).is_err());
    }
}
