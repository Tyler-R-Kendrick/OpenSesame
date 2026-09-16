//! Root capacity under parallel consumers.
//!
//! The property: **however many consumers draw on a root concurrently, and in
//! whatever interleaving, the total they succeed in spending never exceeds the
//! cap.** Two arrangements are exercised, because they are the two ways a real
//! store hosts a [`BudgetLedger`]:
//!
//! - **Serialized.** One ledger behind a mutex, each consumer holding the lock
//!   for its whole reserve-then-settle. This is a store with row-level locking.
//! - **Optimistic.** Each consumer reads the version in one critical section and
//!   commits against it in another, so a lost update has somewhere to hide and
//!   [`BudgetError::VersionConflict`] is reachable. This is a store doing
//!   compare-and-set on a version column.
//!
//! Both finish with [`BudgetLedger::assert_conserved`], which is stronger than
//! comparing totals: it also proves no hold leaked. A race that permanently
//! stranded part of the root's capacity would fail there even though every
//! individual operation returned `Ok`.

use std::sync::{Arc, Mutex};
use std::thread;

use super::testkit::{id, ledger, request, spent};
use super::BudgetLedger;
use crate::budget::fixtures::{at, key};
use crate::budget::{BudgetError, WindowSpec};

type Shared = Arc<Mutex<BudgetLedger>>;

/// One unit at a time, holding the lock across reserve and settle.
fn serialized_consumer(ledger: &Shared, thread_index: u128, attempts: u128) -> u128 {
    let mut settled = 0_u128;
    for attempt in 0..attempts {
        let name = format!("t{thread_index}-{attempt}");
        let mut guard = ledger.lock().expect("ledger mutex");
        if guard.reserve(&request(&name, 1, 60), at(0)).is_err() {
            continue;
        }
        guard.settle_in_full(&id(&name), at(0)).expect("settles");
        settled += 1;
    }
    settled
}

/// One unit at a time, reading the version in a separate critical section from
/// the commit, and returning `(settled, conflicts)`.
fn optimistic_consumer(ledger: &Shared, thread_index: u128, attempts: u128) -> (u128, u128) {
    let mut settled = 0_u128;
    let mut conflicts = 0_u128;
    for attempt in 0..attempts {
        let name = format!("t{thread_index}-{attempt}");
        // Two acquisitions: exactly where a lost update would hide.
        let observed = ledger.lock().expect("ledger mutex").version();
        let mut guard = ledger.lock().expect("ledger mutex");
        if let Err(refusal) = guard.reserve_expecting(observed, &request(&name, 1, 60), at(0)) {
            conflicts += u128::from(matches!(refusal, BudgetError::VersionConflict { .. }));
            assert!(
                matches!(
                    refusal,
                    BudgetError::VersionConflict { .. } | BudgetError::LimitExceeded { .. }
                ),
                "unexpected refusal: {refusal}"
            );
            continue;
        }
        guard.settle_in_full(&id(&name), at(0)).expect("settles");
        settled += 1;
    }
    (settled, conflicts)
}

#[test]
fn serialized_consumers_settle_exactly_the_root_capacity() {
    const CAP: u128 = 100;
    const THREADS: u128 = 8;
    const ATTEMPTS: u128 = 25;

    let shared: Shared = Arc::new(Mutex::new(ledger(CAP, WindowSpec::Lifetime)));
    let handles: Vec<_> = (0..THREADS)
        .map(|thread_index| {
            let ledger = Arc::clone(&shared);
            thread::spawn(move || serialized_consumer(&ledger, thread_index, ATTEMPTS))
        })
        .collect();
    let total: u128 = handles
        .into_iter()
        .map(|handle| handle.join().expect("consumer thread"))
        .sum();

    let ledger = shared.lock().expect("ledger mutex");
    assert_eq!(
        total, CAP,
        "{THREADS} consumers making {ATTEMPTS} attempts each must settle exactly the cap"
    );
    assert_eq!(spent(&ledger, at(0)), CAP);
    assert!(ledger.reading(&key("calls"), at(0)).unwrap().is_exhausted());
    assert_eq!(ledger.open_holds(), 0);
    ledger.assert_conserved().unwrap();
}

#[test]
fn optimistic_consumers_conserve_capacity_and_observe_conflicts() {
    const CAP: u128 = 60;
    const THREADS: u128 = 6;
    const ATTEMPTS: u128 = 40;

    let shared: Shared = Arc::new(Mutex::new(ledger(CAP, WindowSpec::Lifetime)));
    let handles: Vec<_> = (0..THREADS)
        .map(|thread_index| {
            let ledger = Arc::clone(&shared);
            thread::spawn(move || optimistic_consumer(&ledger, thread_index, ATTEMPTS))
        })
        .collect();
    let mut total = 0_u128;
    let mut conflicts = 0_u128;
    for handle in handles {
        let (settled, conflicted) = handle.join().expect("consumer thread");
        total += settled;
        conflicts += conflicted;
    }

    let ledger = shared.lock().expect("ledger mutex");
    assert_eq!(
        spent(&ledger, at(0)),
        total,
        "every success is accounted for exactly once"
    );
    assert!(
        total <= CAP,
        "settled {total} over a cap of {CAP} after {conflicts} conflicts"
    );
    assert!(total > 0, "no consumer made progress");
    assert_eq!(ledger.open_holds(), 0);
    ledger.assert_conserved().unwrap();
}
