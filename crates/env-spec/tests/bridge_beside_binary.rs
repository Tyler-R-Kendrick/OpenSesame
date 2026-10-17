//! The bridge a released binary ships beside itself. A copy of this test binary
//! stands in for `opensesame` in a kit directory, is started as the process
//! that parses, and the recording `node` the operator named
//! (`OPENSESAME_NODE`) says which script it was handed: the one beside the
//! running executable when that file is one only root or the caller could
//! have written, never one anyone can write, and the operator's
//! `OPENSESAME_ENV_PARSE` over either. Same harness as `bridge_isolation.rs`.
#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::PoisonError;

use support::{Sandbox, OPERATOR_NODE, WRITING_OR_FORKING};

const BRIDGE: &str = "opensesame-env-parse.mjs";

/// The subject the other tests start a copy of this binary as.
#[test]
fn subject() {
    support::subject_body();
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// `kit/` (0755) holding a copy of this test binary and a bridge of `mode`,
/// the recording `node` the operator names, and the copy's path.
fn kit(sandbox: &Sandbox, mode: u32) -> PathBuf {
    let kit = sandbox.path("kit");
    std::fs::create_dir(&kit).unwrap();
    chmod(&kit, 0o755);
    let exe = kit.join("opensesame");
    {
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        std::fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        chmod(&exe, 0o755);
        std::fs::write(kit.join(BRIDGE), "// stand-in\n").unwrap();
        chmod(&kit.join(BRIDGE), mode);
    }
    sandbox.plant("operator", "node");
    exe
}

fn run(sandbox: &Sandbox, exe: &Path, extra: &[(&str, String)]) -> String {
    let node = (
        OPERATOR_NODE,
        sandbox.path("operator/node").display().to_string(),
    );
    let extra: Vec<_> = std::iter::once(node).chain(extra.iter().cloned()).collect();
    let path = sandbox.path("safe").display().to_string();
    sandbox.subject_at(exe, &path, &extra)
}

/// The script `node` was handed: its first argument.
fn script(sandbox: &Sandbox) -> Option<String> {
    sandbox
        .arguments("node")
        .and_then(|args| args.into_iter().next())
}

#[test]
fn a_trusted_bridge_beside_the_running_binary_is_the_one_node_runs() {
    let sandbox = Sandbox::new();
    let exe = kit(&sandbox, 0o644);
    assert_eq!(run(&sandbox, &exe, &[]), "ok items=0");
    let beside = sandbox.path("kit").join(BRIDGE).canonicalize().unwrap();
    assert_eq!(script(&sandbox).as_deref(), Some(beside.to_str().unwrap()));
    // The same environment as for any other script: the allowlist, nothing of
    // the passphrase, the operator's variables or the loader's.
    let seen = sandbox.recorded("node").expect("the operator's node ran");
    assert_eq!(support::names(&seen), support::allowlisted(), "{seen}");
    assert!(!seen.contains(support::PASSPHRASE), "{seen}");
}

#[test]
fn a_bridge_anyone_can_write_beside_the_binary_is_refused_naming_why() {
    let sandbox = Sandbox::new();
    let exe = kit(&sandbox, 0o666);
    let said = run(&sandbox, &exe, &[]);
    let beside = sandbox.path("kit").join(BRIDGE).canonicalize().unwrap();
    assert!(
        said.starts_with("err the env-spec bridge beside this executable is not run"),
        "{said}"
    );
    assert!(
        said.contains(&format!("\"{}\" writable by others", beside.display())),
        "{said}"
    );
    assert!(script(&sandbox).is_none(), "node ran: {said}");
}

#[test]
fn the_override_still_wins_over_the_bridge_beside_the_binary() {
    let sandbox = Sandbox::new();
    let exe = kit(&sandbox, 0o644);
    let named = sandbox.path("work/parse.mjs").display().to_string();
    let said = run(&sandbox, &exe, &[("OPENSESAME_ENV_PARSE", named.clone())]);
    assert_eq!(said, "ok items=0");
    assert_eq!(script(&sandbox), Some(named));
}

#[test]
fn with_no_bridge_beside_the_binary_the_checkouts_copy_is_run() {
    let sandbox = Sandbox::new();
    let exe = kit(&sandbox, 0o644);
    std::fs::remove_file(sandbox.path("kit").join(BRIDGE)).unwrap();
    assert_eq!(run(&sandbox, &exe, &[]), "ok items=0");
    // `node` is handed the file the checkout path resolves to, once it is vetted.
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/env-spec-bridge/bin")
        .join(BRIDGE)
        .canonicalize()
        .unwrap();
    assert_eq!(
        script(&sandbox).as_deref(),
        Some(checkout.to_str().unwrap())
    );
}
