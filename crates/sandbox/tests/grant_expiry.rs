//! Grant `expires_at` is enforced at spawn and on every brokered import.

#![cfg(all(feature = "wasm-runtime", feature = "fixtures"))]

mod support;

use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use opensesame_sandbox::fixtures::{chain, root_grant};
use opensesame_sandbox::{RevocationLedger, SandboxError, SandboxProfile};

use support::{sandbox_on, RecordingBroker};

const TRIVIAL: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32) (i32.const 0)))
"#;

const EMIT_ONCE: &str = r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (drop (call $emit (i32.const 0) (i32.const 1)))
    (i32.const 0)))
"#;

fn profile_after_short_ttl() -> SandboxProfile {
    let ttl = ChronoDuration::milliseconds(50);
    let root = root_grant(&["sandbox.emit"], &[], ttl);
    let validated = chain(&[root], 0).expect("fixture chain validates");
    SandboxProfile::from_grant_chain(&validated, Utc::now()).expect("profile mints")
}

#[test]
fn spawn_refuses_after_the_grant_window_closes() {
    let profile = profile_after_short_ttl();
    let ledger = RevocationLedger::at(0);
    let sandbox = sandbox_on(
        profile,
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
        ledger.fence_at(0),
    );
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        sandbox.spawn(&support::wat(TRIVIAL)),
        Err(SandboxError::GrantExpired)
    );
}

#[test]
fn broker_imports_refuse_after_the_grant_window_closes() {
    let profile = profile_after_short_ttl();
    let broker = Arc::new(RecordingBroker::answering(b""));
    let ledger = RevocationLedger::at(0);
    let sandbox = sandbox_on(profile, broker.clone(), ledger.fence_at(0));
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        sandbox.spawn(&support::wat(EMIT_ONCE)),
        Err(SandboxError::GrantExpired)
    );
    assert!(broker.fetched().is_empty());
}
