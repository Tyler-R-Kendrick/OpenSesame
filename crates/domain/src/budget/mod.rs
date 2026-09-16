//! Budget reservation, settlement, and inheritance.
//!
//! A budget is authority measured in quantity rather than in verbs, and it fails
//! in ways a capability set does not: it can be double-spent by two consumers
//! racing, silently widened by a child that says nothing, stranded by a consumer
//! that dies mid-flight, or quietly distorted by a rounded fraction of a cent.
//! The five ideas here answer those, in order:
//!
//! | Concern | Where |
//! |---|---|
//! | Reserve before acting, settle after | [`BudgetLedger::reserve`], [`BudgetLedger::settle`] |
//! | A child inherits what it does not restate | [`Limits::inherit`], [`delegate`] |
//! | A cap without a period is not a cap | [`WindowSpec`] |
//! | Spent, held and available are different facts | [`MeterReading`] |
//! | Exact quantities, never floats | [`Quantity`] |
//!
//! Everything is a **pure value**: no clock, no store, no I/O, no task. Callers
//! pass `now` in and persist the ledger themselves, which is what makes the whole
//! thing testable against adversarial interleavings and adversarial clocks —
//! see `ledger::conservation` for the parallel-consumer proofs.
//!
//! # Two layers refuse a widened budget, by opposite means
//!
//! `crate::grant_attenuation` **refuses** a child grant that omits a budget key
//! its parent metered; [`Limits::inherit`] **binds** an omitted key to the
//! parent's limit. Both fail closed, and [`delegate`] holds the correspondence
//! together with the tests that keep the two from drifting apart.
//!
//! # This is not an event bus
//!
//! Exhaustion, overage and expiry are returned as typed values and nothing else.
//! They are security facts, and this repository already has exactly one road for
//! those: a caller converts them into a `SecurityNotice` and publishes through
//! `security::dispatch` (ADR 0080), inheriting the subscriptions, delivery ledger
//! and sinks that road already has. A second notification path out of this module
//! would be a second thing to get wrong.
//!
//! # Worked example
//!
//! ```
//! use std::collections::BTreeMap;
//! use chrono::Utc;
//! use opensesame_domain::budget::{
//!     Amount, BudgetKey, BudgetLedger, Limit, Limits, Quantity, ReservationId, SpendRequest,
//!     Unit, WindowSpec,
//! };
//!
//! let calls = BudgetKey::parse("invocations")?;
//! // The parent allows ten calls an hour.
//! let parent = Limits::new(
//!     [(
//!         calls.clone(),
//!         Limit::new(Quantity::from_minor_units(10), Unit::count(), WindowSpec::periodic(3_600)?),
//!     )]
//!     .into_iter()
//!     .collect(),
//! );
//! // The child states no budget at all, and inherits the parent's.
//! let effective = Limits::inherit(&parent, &Limits::unmetered())?;
//! assert_eq!(effective.get(&calls).map(Limit::cap), Some(Quantity::from_minor_units(10)));
//!
//! let now = Utc::now();
//! let mut ledger = BudgetLedger::new(effective, now);
//! let request = SpendRequest::new(ReservationId::parse("run-1")?, 60)?
//!     .spending(calls.clone(), Amount::count(4))?;
//! ledger.reserve(&request, now)?;
//! // The four calls are held: not spent, and not available to anyone else.
//! let reading = ledger.reading(&calls, now)?;
//! assert_eq!(reading.spent(), Quantity::ZERO);
//! assert_eq!(reading.available(), Quantity::from_minor_units(6));
//!
//! // It only used three of the four it held; the fourth comes back.
//! let actual: BTreeMap<_, _> = [(calls.clone(), Amount::count(3))].into_iter().collect();
//! ledger.settle(request.id(), &actual, now)?;
//! let reading = ledger.reading(&calls, now)?;
//! assert_eq!(reading.spent(), Quantity::from_minor_units(3));
//! assert_eq!(reading.available(), Quantity::from_minor_units(7));
//! ledger.assert_conserved()?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

mod amount;
pub mod delegate;
mod error;
mod grant_budgets;
mod key;
mod ledger;
mod limits;
mod meter;
mod receipt;
mod reservation;
mod window;

#[cfg(test)]
mod fixtures;

pub use amount::{Quantity, Unit, MAX_SCALE};
pub use delegate::{effective_chain_limits, ledger_for_chain};
pub use error::BudgetError;
pub use grant_budgets::{effective_grant_budgets, limits_from_grant_budgets};
pub use key::BudgetKey;
pub use ledger::BudgetLedger;
pub use limits::{Limit, Limits};
pub use meter::{Amount, MeterReading};
pub use receipt::{ReservationOutcome, SettlementReceipt};
pub use reservation::{Hold, Reservation, ReservationId, SpendRequest, MAX_HOLD_SECONDS};
pub use window::{WindowId, WindowSpec, MAX_PERIOD_SECONDS};
