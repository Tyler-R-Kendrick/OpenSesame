//! Every way a budget operation refuses.
//!
//! A budget is a limit, so ambiguity resolves against the spender: anything
//! this module cannot account for exactly becomes one of these, never a
//! rounded number and never a silent pass.

use thiserror::Error;

/// Refusals from the budget ledger. Separate from [`crate::DomainError`] so a
/// caller can tell "you may not spend that" from "that resource is malformed"
/// without string matching, and so this module stays movable to its own crate.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum BudgetError {
    #[error("invalid budget key: {0}")]
    InvalidKey(String),
    #[error("invalid unit: {0}")]
    InvalidUnit(String),
    #[error("invalid window: {0}")]
    InvalidWindow(String),
    #[error("invalid limit for {key}: {detail}")]
    InvalidLimit { key: String, detail: String },
    #[error("{0} is not an exact decimal quantity")]
    NotADecimal(String),
    #[error("{text} carries more precision than unit {unit} records ({scale} digits)")]
    Precision {
        text: String,
        unit: String,
        scale: u8,
    },
    #[error("quantity arithmetic overflowed")]
    Overflow,
    #[error("quantity arithmetic would go negative")]
    Underflow,
    #[error("unit mismatch for {key}: limit is {expected}, amount is {actual}")]
    UnitMismatch {
        key: String,
        expected: String,
        actual: String,
    },
    /// A child named a budget dimension its parent never granted. Inventing a
    /// key is widening, not narrowing: it would be metered against a limit
    /// nobody above authorized.
    #[error("budget key {0} is not in the parent's limits")]
    UnknownKey(String),
    #[error("budget {key} may only narrow: {detail}")]
    WidenForbidden { key: String, detail: String },
    /// The reservation, or the settled overage, does not fit under the cap.
    #[error("budget {key} exhausted: requested {requested}, available {available}")]
    LimitExceeded {
        key: String,
        requested: String,
        available: String,
    },
    /// Optimistic concurrency lost. The caller read one state and another
    /// consumer committed first; re-read and decide again.
    #[error("budget ledger version mismatch: expected {expected}, actual {actual}")]
    VersionConflict { expected: u64, actual: u64 },
    /// `now` moved backwards. Accepting it would resurrect an elapsed window
    /// or an expired hold, so it is refused instead.
    #[error("clock regression: ledger observed {observed}, caller offered {offered}")]
    ClockRegression { observed: String, offered: String },
    #[error("no such open reservation: {0}")]
    UnknownReservation(String),
    /// A retry named an existing reservation but asked for something else, or
    /// named one that already closed. Answering either as a fresh reservation
    /// would spend twice under one idempotency key, which is the exact failure
    /// the key exists to prevent.
    #[error("reservation {id} cannot be replayed: {detail}")]
    ReplayMismatch { id: String, detail: String },
    /// The hold elapsed before settlement, so its funds already returned to
    /// the pool and may have been spent by someone else.
    #[error("reservation {0} expired before it settled")]
    ReservationExpired(String),
    #[error("a reservation must ask for at least one budget key")]
    EmptyRequest,
    #[error("budget key {0} appears twice in one request")]
    DuplicateKey(String),
    /// Conservation broke. Only reachable from a bug in this module or a
    /// hand-edited persisted ledger; it is checked rather than assumed.
    #[error("budget ledger invariant violated: {0}")]
    Invariant(String),
}
