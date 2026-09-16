//! Conservation of a root's capacity, sequentially.
//!
//! These are the cases a human can name: a hold is not a spend, an unused hold
//! comes back, a replay is not a second spend, a lapsed hold returns its
//! quantity, a window refills, a clock cannot run backwards. The parallel proofs
//! of the same invariant are in `super::parallel`.
//!
//! Every test finishes with [`BudgetLedger::assert_conserved`], so an operation
//! that balanced its own arithmetic but leaked a hold still fails here.

use super::testkit::{id, ledger, request, spent, usage};
use super::BudgetLedger;
use crate::budget::fixtures::{at, hourly, key, limits, next_boundary, TestClock};
use crate::budget::{Amount, BudgetError, Limit, Quantity, SpendRequest, Unit, WindowSpec};

#[test]
fn a_hold_is_not_a_spend_but_is_not_available_either() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    let reading = ledger.reading(&key("calls"), at(0)).unwrap();
    assert_eq!(reading.spent(), Quantity::ZERO, "a hold is not yet spent");
    assert_eq!(reading.held(), Quantity::from_minor_units(4));
    assert_eq!(reading.available(), Quantity::from_minor_units(6));
    ledger.assert_conserved().unwrap();

    ledger.settle(&id("r1"), &usage(3), at(1)).unwrap();
    let reading = ledger.reading(&key("calls"), at(1)).unwrap();
    assert_eq!(reading.spent(), Quantity::from_minor_units(3));
    assert_eq!(reading.held(), Quantity::ZERO);
    assert_eq!(
        reading.available(),
        Quantity::from_minor_units(7),
        "the unused quarter of the hold comes back"
    );
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_released_hold_returns_the_whole_amount() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 10, 60), at(0)).unwrap();
    assert!(ledger.reading(&key("calls"), at(0)).unwrap().is_exhausted());
    ledger.release(&id("r1"), at(1)).unwrap();
    assert_eq!(
        ledger.reading(&key("calls"), at(1)).unwrap().available(),
        Quantity::from_minor_units(10)
    );
    assert_eq!(ledger.open_holds(), 0);
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_replayed_reserve_returns_the_same_hold_and_does_not_double_charge() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    let first = ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    let version = ledger.version();
    let replay = ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    assert_eq!(first, replay);
    assert_eq!(ledger.version(), version, "a replay commits nothing");
    assert_eq!(
        ledger.reading(&key("calls"), at(0)).unwrap().held(),
        Quantity::from_minor_units(4)
    );
    // Same id, different request: answering this would spend twice under one
    // idempotency key.
    assert!(matches!(
        ledger.reserve(&request("r1", 5, 60), at(0)),
        Err(BudgetError::ReplayMismatch { .. })
    ));
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_replayed_settle_returns_the_receipt_and_a_different_report_is_refused() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    let receipt = ledger.settle(&id("r1"), &usage(3), at(1)).unwrap();
    assert_eq!(ledger.settle(&id("r1"), &usage(3), at(2)).unwrap(), receipt);
    assert_eq!(spent(&ledger, at(2)), 3, "the replay recorded nothing more");
    assert!(matches!(
        ledger.settle(&id("r1"), &usage(4), at(3)),
        Err(BudgetError::ReplayMismatch { .. })
    ));
    assert!(matches!(
        ledger.release(&id("r1"), at(3)),
        Err(BudgetError::ReplayMismatch { .. })
    ));
    // A spent id is never reusable.
    assert!(matches!(
        ledger.reserve(&request("r1", 1, 60), at(3)),
        Err(BudgetError::ReplayMismatch { .. })
    ));
    ledger.assert_conserved().unwrap();
}

#[test]
fn releasing_twice_is_the_same_as_releasing_once() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    let first = ledger.release(&id("r1"), at(1)).unwrap();
    assert_eq!(ledger.release(&id("r1"), at(2)).unwrap(), first);
    assert_eq!(spent(&ledger, at(2)), 0);
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_multi_key_request_is_admitted_whole_or_not_at_all() {
    let usd = Unit::new("usd", 2).unwrap();
    let mut ledger = BudgetLedger::new(
        limits(vec![
            (
                "calls",
                Limit::new(
                    Quantity::from_minor_units(10),
                    Unit::count(),
                    WindowSpec::Lifetime,
                ),
            ),
            (
                "usd",
                Limit::new(
                    Quantity::from_minor_units(100),
                    usd.clone(),
                    WindowSpec::Lifetime,
                ),
            ),
        ]),
        at(0),
    );
    // The dollars do not fit. The calls must not be held either.
    let overreach = SpendRequest::new(id("r1"), 60)
        .unwrap()
        .spending(key("calls"), Amount::count(1))
        .unwrap()
        .spending(
            key("usd"),
            Amount::new(Quantity::from_minor_units(101), usd),
        )
        .unwrap();
    assert!(matches!(
        ledger.reserve(&overreach, at(0)),
        Err(BudgetError::LimitExceeded { .. })
    ));
    assert_eq!(
        ledger.reading(&key("calls"), at(0)).unwrap().held(),
        Quantity::ZERO,
        "a refused dimension must not leave a hold on the others"
    );
    assert_eq!(ledger.open_holds(), 0);
    ledger.assert_conserved().unwrap();
}

#[test]
fn an_overage_is_allowed_under_the_cap_and_refused_over_it() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    // Used more than held, but the cap still covers it.
    ledger.settle(&id("r1"), &usage(6), at(1)).unwrap();
    assert_eq!(spent(&ledger, at(1)), 6);

    ledger.reserve(&request("r2", 4, 60), at(2)).unwrap();
    assert!(matches!(
        ledger.settle(&id("r2"), &usage(5), at(3)),
        Err(BudgetError::LimitExceeded { .. })
    ));
    assert_eq!(
        ledger.open_holds(),
        1,
        "a refused settlement leaves the hold for the caller to release"
    );
    ledger.assert_conserved().unwrap();
    ledger.release(&id("r2"), at(4)).unwrap();
    ledger.assert_conserved().unwrap();
}

#[test]
fn an_expired_hold_returns_its_capacity_and_cannot_settle() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 10, 60), at(0)).unwrap();
    // At the deadline the hold is gone and the capacity is spendable again.
    assert_eq!(
        ledger.reading(&key("calls"), at(60)).unwrap().available(),
        Quantity::from_minor_units(10)
    );
    ledger.reserve(&request("r2", 10, 60), at(60)).unwrap();
    assert!(matches!(
        ledger.settle(&id("r1"), &usage(10), at(61)),
        Err(BudgetError::ReservationExpired(_))
    ));
    assert_eq!(
        spent(&ledger, at(61)),
        0,
        "a lapsed hold cannot spend capacity somebody else now holds"
    );
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_hold_may_not_outlive_the_window_it_spends_from() {
    let mut ledger = ledger(10, hourly());
    // A full-hour hold taken a minute before the boundary is cut short at it.
    let held = ledger.reserve(&request("r1", 4, 3_600), at(3_540)).unwrap();
    assert_eq!(
        held.expires_at(),
        next_boundary(hourly(), at(3_540)).unwrap()
    );
    assert!(matches!(
        ledger.settle(&id("r1"), &usage(4), at(3_600)),
        Err(BudgetError::ReservationExpired(_))
    ));
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_window_refills_without_anything_being_reset() {
    let mut clock = TestClock::starting_at(0);
    let mut ledger = ledger(10, hourly());
    ledger.reserve(&request("r1", 10, 60), clock.now()).unwrap();
    ledger
        .settle(&id("r1"), &usage(10), clock.advance_seconds(1))
        .unwrap();
    assert!(ledger
        .reading(&key("calls"), clock.now())
        .unwrap()
        .is_exhausted());

    let next = clock.advance_to_next_window(hourly());
    let reading = ledger.reading(&key("calls"), next).unwrap();
    assert_eq!(reading.spent(), Quantity::ZERO);
    assert_eq!(reading.available(), Quantity::from_minor_units(10));
    ledger.reserve(&request("r2", 10, 60), next).unwrap();
    ledger.assert_conserved().unwrap();
}

#[test]
fn a_clock_that_runs_backwards_is_refused() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    ledger.reserve(&request("r1", 1, 60), at(100)).unwrap();
    assert!(matches!(
        ledger.reserve(&request("r2", 1, 60), at(99)),
        Err(BudgetError::ClockRegression { .. })
    ));
    assert!(matches!(
        ledger.tick(at(0)),
        Err(BudgetError::ClockRegression { .. })
    ));
    assert_eq!(ledger.observed_now(), at(100));
}

#[test]
fn a_stale_version_loses_the_race_deterministically() {
    let mut ledger = ledger(10, WindowSpec::Lifetime);
    let read_at = ledger.version();
    ledger
        .reserve_expecting(read_at, &request("r1", 1, 60), at(0))
        .unwrap();
    // A second consumer that read the same version has been overtaken.
    assert!(matches!(
        ledger.reserve_expecting(read_at, &request("r2", 1, 60), at(0)),
        Err(BudgetError::VersionConflict { expected, actual })
            if expected == read_at && actual == read_at + 1
    ));
    ledger.assert_conserved().unwrap();
}

#[test]
fn time_passing_does_not_advance_the_version() {
    let mut ledger = ledger(10, hourly());
    ledger.reserve(&request("r1", 4, 60), at(0)).unwrap();
    let version = ledger.version();
    // The hold lapses and the window turns over; neither is a caller's commit,
    // so a compare-and-set loop must not be made to spin by either.
    ledger.tick(at(7_200)).unwrap();
    assert_eq!(ledger.version(), version);
    ledger
        .reserve_expecting(version, &request("r2", 10, 60), at(7_200))
        .unwrap();
    ledger.assert_conserved().unwrap();
}
