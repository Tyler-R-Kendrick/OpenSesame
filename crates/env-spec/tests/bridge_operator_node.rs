//! `OPENSESAME_NODE`: the operator names the exact `node` the bridge runs. It
//! is consulted first, it is exempt from the directory and file checks of the
//! `PATH` search (the operator chose that file, with the trust of
//! `OPENSESAME_ENV_PARSE`), a value that cannot be used is an error that names
//! the variable and never becomes the `PATH` search, and the variable is not
//! passed on to the bridge. Same harness as `bridge_isolation.rs`.
#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;

use support::{allowlisted, names, Sandbox, OPERATOR_NODE, PASSPHRASE};

/// The subject the other tests start this binary as.
#[test]
fn subject() {
    support::subject_body();
}

/// The operator named the exact file, so it wins over a trusted one on `PATH`,
/// and the bridge is still given only the allowlisted environment: the
/// variable that chose it is not among it.
#[test]
fn the_operators_node_wins_over_a_trusted_one_on_path() {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    sandbox.plant("operator", "operator");
    let chosen = sandbox.path("operator/node").display().to_string();
    let path = format!(":./bin:{}", sandbox.path("safe").display());
    let said = sandbox.subject_with(&path, &[(OPERATOR_NODE, chosen)]);
    assert_eq!(said, "ok items=0");
    assert!(sandbox.recorded("trusted").is_none(), "PATH's node ran");
    let seen = sandbox.recorded("operator").expect("the named node ran");
    assert_eq!(
        names(&seen),
        allowlisted(),
        "the bridge was handed:\n{seen}"
    );
    assert!(!seen.contains(OPERATOR_NODE), "{seen}");
    assert!(!seen.contains(PASSPHRASE), "{seen}");
}

/// The operator's file is exempt from the directory and file checks: the same
/// trust as `OPENSESAME_ENV_PARSE`. A 0777 file in a 0777 directory is used
/// when no `PATH` entry could supply one.
#[test]
fn the_operators_node_is_used_in_a_directory_and_as_a_file_anyone_can_write() {
    let sandbox = Sandbox::new();
    sandbox.plant("unsafe", "operator");
    std::fs::set_permissions(
        sandbox.path("unsafe/node"),
        std::fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let chosen = sandbox.path("unsafe/node").display().to_string();
    let said = sandbox.subject_with(":./bin:.", &[(OPERATOR_NODE, chosen)]);
    assert_eq!(said, "ok items=0");
    assert!(sandbox.recorded("operator").is_some());
}

/// A value the operator set and that cannot be used is an error that names the
/// variable. It never quietly becomes the `PATH` search: they meant it.
#[test]
fn a_bad_operator_value_is_refused_by_name_and_never_falls_back_to_path() {
    for case in [
        "empty",
        "relative",
        "dot-relative",
        "missing",
        "directory",
        "not-executable",
    ] {
        let sandbox = Sandbox::new();
        sandbox.plant("safe", "trusted");
        sandbox.plant("work", "in-cwd");
        std::fs::write(sandbox.path("operator/plain"), "x").unwrap();
        let value = match case {
            "empty" => String::new(),
            "relative" => "node".to_owned(),
            "dot-relative" => "./bin/../node".to_owned(),
            "missing" => sandbox.path("operator/nope").display().to_string(),
            "directory" => sandbox.path("safe").display().to_string(),
            _ => sandbox.path("operator/plain").display().to_string(),
        };
        let path = format!(":./bin:{}", sandbox.path("safe").display());
        let said = sandbox.subject_with(&path, &[(OPERATOR_NODE, value.clone())]);
        assert!(said.starts_with("err "), "{case} ({value:?}): {said}");
        assert!(said.contains(OPERATOR_NODE), "{case} ({value:?}): {said}");
        for label in ["trusted", "in-cwd"] {
            assert!(
                sandbox.recorded(label).is_none(),
                "{case} ({value:?}): the `{label}` node ran after a bad OPENSESAME_NODE"
            );
        }
    }
}
