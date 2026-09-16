//! SBOX-BOUNDARY against the real engine: what a hostile guest cannot reach.
//!
//! Every module here is compiled by Wasmtime and actually linked. A test
//! that asserted on a mock linker would prove only that the mock agrees
//! with the test, so the refusals are taken from the engine itself.

#![cfg(all(feature = "wasm-runtime", feature = "fixtures"))]

mod support;

use std::sync::Arc;

use opensesame_sandbox::SandboxError;

use support::{profile_with, sandbox_with, RecordingBroker};

#[test]
fn a_guest_importing_wasi_never_instantiates() {
    let guest = support::wat(
        r#"
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.const 0)))
"#,
    );
    match support::permissive_sandbox().spawn(&guest) {
        Err(SandboxError::AmbientImport { module, name, kind }) => {
            assert_eq!(module, "wasi_snapshot_preview1");
            assert_eq!(name, "fd_write");
            assert_eq!(kind, "filesystem");
        }
        other => panic!("a WASI importer must be refused, got {other:?}"),
    }
}

#[test]
fn every_ambient_surface_is_refused_on_the_real_engine() {
    let sandbox = support::permissive_sandbox();
    for (module, name, expected) in [
        ("wasi_snapshot_preview1", "path_open", "filesystem"),
        ("wasi_snapshot_preview1", "sock_connect", "network"),
        ("wasi_snapshot_preview1", "environ_get", "environment"),
        ("wasi_snapshot_preview1", "clock_time_get", "clock"),
        ("wasi_snapshot_preview1", "random_get", "randomness"),
        ("wasi_snapshot_preview1", "proc_exit", "process"),
        ("env", "sneaky", "unclassified"),
    ] {
        let guest = support::wat(&format!(
            r#"
(module
  (import "{module}" "{name}" (func $f))
  (memory (export "memory") 1)
  (func (export "run") (result i32) (call $f) (i32.const 0)))
"#
        ));
        match sandbox.spawn(&guest) {
            Err(SandboxError::AmbientImport { kind, .. }) => assert_eq!(kind, expected),
            other => panic!("{module}::{name} must be refused, got {other:?}"),
        }
    }
}

#[test]
fn a_guest_cannot_ask_the_host_for_a_memory_and_escape_the_cap() {
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "memory" (memory 1))
  (func (export "run") (result i32) (i32.const 0)))
"#,
    );
    assert_eq!(
        support::permissive_sandbox().spawn(&guest),
        Err(SandboxError::HostSuppliedState("memory"))
    );
}

#[test]
fn an_ungranted_capability_does_not_exist_to_link_against() {
    // The profile grants emit only; the guest wants to sign. Note that the
    // refusal happens at link time — the guest never runs and so never gets
    // to find out whether a call would have been denied.
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "sign"
    (func $sign (param i32 i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (call $sign (i32.const 0) (i32.const 1) (i32.const 0) (i32.const 1)
                (i32.const 64) (i32.const 64))))
"#,
    );
    let sandbox = sandbox_with(
        profile_with(&["sandbox.emit"]),
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
    );
    assert_eq!(
        sandbox.spawn(&guest),
        Err(SandboxError::CapabilityNotGranted("sign".into()))
    );
}

#[test]
fn an_invented_brokered_name_is_refused_rather_than_guessed_at() {
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "get-secret" (func $s (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32) (call $s)))
"#,
    );
    assert_eq!(
        support::permissive_sandbox().spawn(&guest),
        Err(SandboxError::UnknownBrokeredImport("get-secret".into()))
    );
}

#[test]
fn an_out_of_bounds_pointer_is_a_refusal_not_a_host_read() {
    // The guest asks the host to read past the end of a one-page memory.
    // The host must not read its own address space, and must not tear the
    // process down — it answers "bad pointer" and the run continues.
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (call $emit (i32.const 65000) (i32.const 4096))))
"#,
    );
    let broker = Arc::new(RecordingBroker::answering(b""));
    let sandbox = sandbox_with(
        profile_with(&["sandbox.emit"]),
        Arc::clone(&broker) as Arc<_>,
    );
    let outcome = sandbox.spawn(&guest).expect("a bad pointer is not a trap");
    assert_eq!(outcome.status, -3, "BadPointer");
    assert!(outcome.emitted.is_empty());
    assert_eq!(broker.emitted().len(), 0, "the broker was never reached");
}

#[test]
fn a_guest_with_a_brokered_import_but_no_memory_cannot_move_bytes() {
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "emit" (func $emit (param i32 i32) (result i32)))
  (func (export "run") (result i32)
    (call $emit (i32.const 0) (i32.const 1))))
"#,
    );
    let sandbox = sandbox_with(
        profile_with(&["sandbox.emit"]),
        Arc::new(RecordingBroker::answering(b"")) as Arc<_>,
    );
    assert_eq!(sandbox.spawn(&guest), Err(SandboxError::MissingMemory));
}

#[test]
fn a_token_reaches_the_guest_as_a_handle_and_never_as_bytes() {
    // The ABI has no way to return token material: `token-acquire` answers
    // with an integer. A guest that wanted the value has nowhere to put it.
    let guest = support::wat(
        r#"
(module
  (import "opensesame:sandbox" "token-acquire" (func $token (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "repo:read")
  (func (export "run") (result i32)
    (call $token (i32.const 0) (i32.const 9))))
"#,
    );
    let broker = Arc::new(RecordingBroker::answering(b"super-secret-token"));
    let sandbox = sandbox_with(
        profile_with(&["sandbox.token"]),
        Arc::clone(&broker) as Arc<_>,
    );
    let outcome = sandbox.spawn(&guest).expect("acquiring a token succeeds");
    assert_eq!(outcome.status, 1, "the handle, not the token");
    assert_eq!(broker.scopes(), vec!["repo:read".to_owned()]);
    assert!(outcome.emitted.is_empty());
}
