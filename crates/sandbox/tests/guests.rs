//! SBOX-SPAWN against the real engine: the honest workload, and the limits.
//!
//! Nothing here is stubbed. Fuel really runs out, the limiter really
//! refuses a growing memory, and the epoch really interrupts a loop. The
//! boundary refusals live in `boundary.rs`; this file is about what a run
//! costs and where it stops.

#![cfg(all(feature = "wasm-runtime", feature = "fixtures"))]

mod support;

use std::sync::Arc;
use std::time::Duration;

use opensesame_sandbox::{BrokeredCapability, SandboxError, SandboxProfile};

use support::{profile_with, sandbox_with, RecordingBroker};

/// The honest fixture workload: fetch a brokered resource, fold the bytes,
/// emit the result. It touches every part of the boundary a real job would
/// — an argument read out of guest memory, a host call, a response written
/// back in, and a result handed out.
const HONEST_WORKLOAD: &str = r#"
(module
  (import "opensesame:sandbox" "http-fetch"
    (func $fetch (param i32 i32 i32 i32) (result i32)))
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "catalog/v1")
  (func (export "run") (result i32)
    (local $n i32) (local $i i32) (local $sum i32)
    (local.set $n (call $fetch (i32.const 0) (i32.const 10) (i32.const 256) (i32.const 512)))
    (if (i32.lt_s (local.get $n) (i32.const 0))
      (then (return (local.get $n))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $sum
          (i32.add (local.get $sum)
            (i32.load8_u (i32.add (i32.const 256) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i32.store (i32.const 1024) (local.get $sum))
    (drop (call $emit (i32.const 1024) (i32.const 4)))
    (i32.const 0)))
"#;

#[test]
fn the_honest_workload_runs_end_to_end_through_the_broker() {
    let broker = Arc::new(RecordingBroker::answering(b"abcd"));
    let sandbox = sandbox_with(
        profile_with(&["sandbox.http", "sandbox.emit"]),
        Arc::clone(&broker) as Arc<_>,
    );

    let outcome = sandbox
        .spawn(&support::wat(HONEST_WORKLOAD))
        .expect("the honest workload completes");

    assert_eq!(outcome.status, 0);
    assert!(outcome.guest_reported_ok());
    // 'a'+'b'+'c'+'d' == 394, little-endian in the four emitted bytes.
    assert_eq!(outcome.emitted, 394_i32.to_le_bytes().to_vec());
    assert_eq!(outcome.broker_calls, 2);
    assert_eq!(broker.fetched(), vec!["catalog/v1".to_owned()]);
    assert!(outcome.fuel_used > 0, "a real run burns real fuel");
}

#[test]
fn each_run_gets_a_fresh_store_with_nothing_left_from_the_last_one() {
    // The guest writes a marker into its own memory and reports whether it
    // was already there. Two runs of the same module on the same sandbox
    // must both report "not there".
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $seen i32)
    (local.set $seen (i32.load (i32.const 512)))
    (i32.store (i32.const 512) (i32.const 1))
    (local.get $seen)))
"#,
    );
    let sandbox = sandbox_with(
        profile_with(&["sandbox.emit"]),
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
    );
    assert_eq!(sandbox.spawn(&guest).expect("first run").status, 0);
    assert_eq!(
        sandbox.spawn(&guest).expect("second run").status,
        0,
        "the second run saw state the first one left behind"
    );
}

#[test]
fn a_guest_that_loops_forever_runs_out_of_fuel() {
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $i i32)
    (loop $forever
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $forever))
    (i32.const 0)))
"#,
    );
    let profile = support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.fuel", 200_000)]);
    let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
    assert_eq!(sandbox.spawn(&guest), Err(SandboxError::FuelExhausted));
}

#[test]
fn a_memory_bomb_is_refused_growth_rather_than_granted_it() {
    // 64 pages is 4MiB; the profile caps memory at 1MiB, so the grow fails
    // and the guest sees -1 — the honest wasm answer — instead of the host
    // handing over pages it promised not to.
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (memory.grow (i32.const 64))))
"#,
    );
    let profile =
        support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.memory_bytes", 1024 * 1024)]);
    let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
    let outcome = sandbox.spawn(&guest).expect("a refused grow is not a trap");
    assert_eq!(outcome.status, -1, "memory.grow must report failure");
}

#[test]
fn a_module_declaring_more_memory_than_its_cap_never_instantiates() {
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 64)
  (func (export "run") (result i32) (i32.const 0)))
"#,
    );
    let profile =
        support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.memory_bytes", 1024 * 1024)]);
    let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
    assert_eq!(sandbox.spawn(&guest), Err(SandboxError::MemoryLimit));
}

#[test]
fn a_guest_cannot_emit_more_than_its_budget() {
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (call $emit (i32.const 0) (i32.const 4096))))
"#,
    );
    let profile = support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.emit_bytes", 16)]);
    let broker = Arc::new(RecordingBroker::answering(b""));
    let sandbox = sandbox_with(profile, Arc::clone(&broker) as Arc<_>);
    let outcome = sandbox.spawn(&guest).expect("an oversized emit is refused");
    assert_eq!(outcome.status, -2, "Oversized");
    assert!(outcome.emitted.is_empty());
    assert_eq!(broker.emitted().len(), 0);
}

#[test]
fn emitting_in_small_pieces_does_not_get_a_guest_past_the_cap() {
    // Each call is well under the 16-byte cap; together they are not. The
    // running total is what the boundary meters.
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $i i32) (local $last i32)
    (loop $again
      (local.set $last (call $emit (i32.const 0) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 10))))
    (local.get $last)))
"#,
    );
    let profile = support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.emit_bytes", 16)]);
    let broker = Arc::new(RecordingBroker::answering(b""));
    let sandbox = sandbox_with(profile, Arc::clone(&broker) as Arc<_>);
    let outcome = sandbox.spawn(&guest).expect("the run completes");

    assert_eq!(outcome.status, -2, "the later calls are refused");
    assert_eq!(outcome.emitted.len(), 16, "never more than the cap");
    assert_eq!(
        broker.emitted().len(),
        2,
        "the broker is never handed bytes the host then discards"
    );
}

#[test]
fn a_guest_with_no_entry_point_is_refused() {
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "start") (result i32) (i32.const 0)))
"#,
    );
    assert_eq!(
        support::permissive_sandbox().spawn(&guest),
        Err(SandboxError::MissingEntryPoint("run"))
    );
}

#[test]
fn a_profile_with_no_capabilities_still_runs_bounded_compute() {
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (i32.add (i32.const 20) (i32.const 22))))
"#,
    );
    let sandbox = sandbox_with(
        profile_with(&["repository.read"]),
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
    );
    let outcome = sandbox.spawn(&guest).expect("pure compute is allowed");
    assert_eq!(outcome.status, 42);
    assert_eq!(outcome.broker_calls, 0);
}

#[test]
fn a_run_that_outlives_its_deadline_is_interrupted() {
    // Fuel is left at the ceiling so the only thing that can stop this loop
    // is the clock.
    let guest = support::wat(
        r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (local $i i64)
    (loop $forever
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $forever (i64.lt_u (local.get $i) (i64.const 100000000000))))
    (i32.const 0)))
"#,
    );
    let profile = support::profile_with_budgets(&["sandbox.emit"], &[("sandbox.deadline_ms", 60)]);
    let sandbox = sandbox_with(profile, Arc::new(RecordingBroker::answering(b"")) as Arc<_>);
    let started = std::time::Instant::now();
    let refused = sandbox.spawn(&guest);
    assert_eq!(
        refused,
        Err(SandboxError::DeadlineExceeded),
        "the clock, not the fuel, must be what stops this one"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the stop must be prompt, took {:?}",
        started.elapsed()
    );
}

#[test]
fn a_guest_stalled_inside_the_broker_is_bounded_by_the_clock_alone() {
    // Waiting on a host call burns no fuel, so fuel cannot bound this run.
    // If the deadline did not also apply, a guest could hold a slot open
    // indefinitely by calling a slow destination in a loop.
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "http-fetch"
    (func $fetch (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "slow")
  (func (export "run") (result i32)
    (local $i i32)
    (loop $again
      (drop (call $fetch (i32.const 0) (i32.const 4) (i32.const 256) (i32.const 256)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 20))))
    (i32.const 0)))
"#,
    );
    let profile = support::profile_with_budgets(&["sandbox.http"], &[("sandbox.deadline_ms", 100)]);
    let sandbox = sandbox_with(
        profile,
        Arc::new(support::StallingBroker::for_(Duration::from_millis(60))) as Arc<_>,
    );

    let started = std::time::Instant::now();
    assert_eq!(sandbox.spawn(&guest), Err(SandboxError::DeadlineExceeded));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn the_profile_a_sandbox_enforces_is_the_one_it_was_built_with() {
    let sandbox = sandbox_with(
        profile_with(&["sandbox.emit", "sandbox.http"]),
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
    );
    let profile: &SandboxProfile = sandbox.profile();
    assert!(profile.grants(BrokeredCapability::Emit));
    assert!(profile.grants(BrokeredCapability::HttpFetch));
    assert!(!profile.grants(BrokeredCapability::Sign));
    assert!(profile.ambient_denial().is_total());
}
