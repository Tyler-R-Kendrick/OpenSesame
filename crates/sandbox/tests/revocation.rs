//! SBOX-REVOKE against the real engine.
//!
//! The question these tests answer is the one that makes revocation worth
//! having: does it reach a run that is *already executing*? A fence checked
//! only at spawn would pass a unit test and fail the incident.

#![cfg(all(feature = "wasm-runtime", feature = "fixtures"))]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use opensesame_sandbox::{RevocationLedger, SandboxError};

use support::{profile_with, profile_with_budgets, sandbox_on, sandbox_with, RecordingBroker};

/// A loop that makes no host calls at all — the case a boundary check alone
/// cannot stop, because the guest never comes back to the boundary.
const SPINNER: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $i i64)
    (loop $forever
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $forever (i64.lt_u (local.get $i) (i64.const 1000000000000))))
    (i32.const 0)))
"#;

/// A loop that calls the broker every iteration.
const CHATTY: &str = r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $i i32)
    (loop $again
      (drop (call $emit (i32.const 0) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 1000000))))
    (i32.const 0)))
"#;

const TRIVIAL: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32) (i32.const 0)))
"#;

#[test]
fn a_stale_profile_cannot_start_a_run_at_all() {
    let ledger = RevocationLedger::at(0);
    let profile = profile_with(&["sandbox.emit"]);
    let fence = ledger.fence_at(profile.invalidation_generation());
    let sandbox = sandbox_on(
        profile,
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
        fence,
    );

    // Authority changes before the run begins.
    assert_eq!(ledger.revoke(), 1);

    assert_eq!(
        sandbox.spawn(&support::wat(TRIVIAL)),
        Err(SandboxError::Revoked {
            expected: 0,
            observed: 1
        })
    );
}

#[test]
fn revoking_mid_run_kills_a_guest_that_never_calls_the_host() {
    let profile = profile_with_budgets(&["sandbox.emit"], &[("sandbox.deadline_ms", 5_000)]);
    let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
    let kill = sandbox.kill_switch();
    let guest = support::wat(SPINNER);

    let started = Instant::now();
    let runner = std::thread::spawn(move || sandbox.spawn(&guest));
    // Let the guest get properly underway before pulling authority.
    std::thread::sleep(Duration::from_millis(50));
    assert!(kill.is_live(), "the run should still be authorized here");
    kill.kill();

    let outcome = runner.join().expect("the guest thread joins");
    let elapsed = started.elapsed();

    assert!(
        matches!(outcome, Err(SandboxError::Revoked { .. })),
        "a revoked spinner must report revocation, got {outcome:?}"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "the kill must land long before the 5s deadline; took {elapsed:?}"
    );
    assert!(!kill.is_live());
}

#[test]
fn a_kill_landing_while_the_module_compiles_is_not_lost() {
    // Compiling and instantiating takes real time, and a kill arriving in
    // that window bumps an epoch the store has not been armed against yet.
    // Without a re-check just before the guest starts, the run would begin
    // anyway and then be reported as whatever limit happened to stop it —
    // "fuel exhausted" for a run whose authority had already been pulled,
    // which reads as "retry with a bigger budget". It must read as revoked.
    for delay_micros in [0, 200, 1_000, 5_000, 20_000] {
        let profile = profile_with_budgets(&["sandbox.emit"], &[("sandbox.deadline_ms", 5_000)]);
        let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
        let kill = sandbox.kill_switch();
        let guest = support::wat(SPINNER);

        let runner = std::thread::spawn(move || sandbox.spawn(&guest));
        std::thread::sleep(Duration::from_micros(delay_micros));
        kill.kill();

        let outcome = runner.join().expect("the guest thread joins");
        assert!(
            matches!(outcome, Err(SandboxError::Revoked { .. })),
            "a kill at {delay_micros}us must report revocation, got {outcome:?}"
        );
    }
}

#[test]
fn revocation_closes_the_boundary_before_it_stops_the_guest() {
    // A chatty guest reaches the boundary constantly, so the fence check in
    // the import is what fires first. Either way the run ends as revoked —
    // never as a completed run whose results the host then accepts.
    let profile = profile_with_budgets(&["sandbox.emit"], &[("sandbox.deadline_ms", 5_000)]);
    let broker = Arc::new(RecordingBroker::answering(b""));
    let sandbox = sandbox_with(profile, Arc::clone(&broker) as Arc<_>);
    let kill = sandbox.kill_switch();
    let guest = support::wat(CHATTY);

    let runner = std::thread::spawn(move || sandbox.spawn(&guest));
    std::thread::sleep(Duration::from_millis(30));
    kill.kill();

    let outcome = runner.join().expect("the guest thread joins");
    assert!(
        matches!(outcome, Err(SandboxError::Revoked { .. })),
        "got {outcome:?}"
    );

    // Whatever the guest managed before the kill, it stopped there: the
    // broker is not still being called after the join.
    let before = broker.emitted().len();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(before, broker.emitted().len(), "the boundary stayed shut");
}

#[test]
fn a_tenant_wide_revocation_reaches_a_run_nobody_went_looking_for() {
    // The ledger bump does not know about this run. That is the point: the
    // generation fence invalidates it anyway.
    let profile = profile_with_budgets(&["sandbox.emit"], &[("sandbox.deadline_ms", 5_000)]);
    let ledger = RevocationLedger::at(profile.invalidation_generation());
    let fence = ledger.fence_at(profile.invalidation_generation());
    let sandbox = sandbox_on(
        profile,
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
        fence,
    );
    let kill = sandbox.kill_switch();
    let guest = support::wat(CHATTY);

    let runner = std::thread::spawn(move || sandbox.spawn(&guest));
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(ledger.revoke(), 1, "the tenant's authority moved on");
    // The epoch bump is how a *spinning* guest is reached; the fence alone
    // is what a chatty one hits. A real caller does both, as here.
    kill.kill();

    let outcome = runner.join().expect("the guest thread joins");
    assert!(
        matches!(outcome, Err(SandboxError::Revoked { .. })),
        "got {outcome:?}"
    );
}

#[test]
fn a_run_that_finished_before_the_revocation_still_stands() {
    // Revocation is not retroactive: work completed under live authority is
    // completed. Asserting this keeps a future "revoke everything" change
    // from quietly invalidating settled receipts.
    let profile = profile_with(&["sandbox.emit"]);
    let ledger = RevocationLedger::at(profile.invalidation_generation());
    let fence = ledger.fence_at(profile.invalidation_generation());
    let sandbox = sandbox_on(
        profile,
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
        fence,
    );
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "done")
  (func (export "run") (result i32)
    (drop (call $emit (i32.const 0) (i32.const 4)))
    (i32.const 0)))
"#,
    );

    let outcome = sandbox.spawn(&guest).expect("the run completes");
    assert_eq!(outcome.emitted, b"done".to_vec());

    assert_eq!(ledger.revoke(), 1);
    assert_eq!(outcome.emitted, b"done".to_vec());
    // But nothing new starts.
    assert!(matches!(
        sandbox.spawn(&guest),
        Err(SandboxError::Revoked { .. })
    ));
}
