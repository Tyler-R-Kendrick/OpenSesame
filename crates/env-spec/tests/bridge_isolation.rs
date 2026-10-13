//! The Node bridge that reads a schema is started with a `node` this crate
//! found itself and with a minimal environment: the process that runs
//! `parse_schema_file` may hold the store passphrase, and the bridge is not
//! who it is kept from only when it never sees it.
//!
//! `parse_schema_file` reads the process it runs in (`PATH`, the working
//! directory, the environment), so each test starts this very test binary
//! again as a subject (`subject` below) with exactly the process state it
//! wants, and reads what the subject printed and what the `node` it started
//! left behind. The `node` here is a shell script that records its
//! environment and answers with an empty document; one test also runs the real
//! Node when there is one.
#![cfg(unix)]

mod support;

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::PoisonError;

use support::{names, Sandbox, EMPTY_DOCUMENT, PASSPHRASE, SHELL_OWN, WRITING_OR_FORKING};

/// The subject the other tests start this binary as.
#[test]
fn subject() {
    support::subject_body();
}

/// A `node` is planted where a bare `node` lookup would find it, ahead of the
/// only trusted one; it must never run, and the bridge must still parse.
fn planted_node_never_runs(path_template: &str, planted_in: &str) {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    sandbox.plant(planted_in, "planted");
    let path = path_template.replace("{safe}", &sandbox.path("safe").display().to_string());
    let path = path.replace("{unsafe}", &sandbox.path("unsafe").display().to_string());
    let said = sandbox.subject(&path);
    if let Some(seen) = sandbox.recorded("planted") {
        panic!(
            "a node planted in `{planted_in}` ran with PATH={path}, and saw:\n{seen}\n(subject: {said})"
        );
    }
    assert_eq!(said, "ok items=0", "PATH={path}");
    assert!(
        sandbox.recorded("trusted").is_some(),
        "the trusted node did not run (PATH={path})"
    );
}

#[test]
fn a_node_in_the_working_directory_behind_an_empty_path_entry_never_runs() {
    planted_node_never_runs(":{safe}", "work");
}

#[test]
fn a_node_in_the_working_directory_behind_a_dot_path_entry_never_runs() {
    planted_node_never_runs(".:{safe}", "work");
}

#[test]
fn a_node_behind_a_relative_path_entry_never_runs() {
    planted_node_never_runs("./bin:{safe}", "work/bin");
}

#[test]
fn a_node_in_a_directory_others_can_write_never_runs() {
    planted_node_never_runs("{unsafe}:{safe}", "unsafe");
}

/// The layout a CI image or a package manager under `umask 002` produces: an
/// absolute directory this user owns, group-writable by this user's own group.
/// It holds the only node, behind a planted one in an empty entry.
#[test]
fn a_directory_its_own_group_can_write_is_trusted() {
    let sandbox = Sandbox::new();
    std::fs::set_permissions(sandbox.path("safe"), std::fs::Permissions::from_mode(0o775)).unwrap();
    sandbox.plant("safe", "trusted");
    sandbox.plant("work", "planted");
    let path = format!(":./bin:{}", sandbox.path("safe").display());
    let said = sandbox.subject(&path);
    assert_eq!(said, "ok items=0", "PATH={path}");
    assert!(
        sandbox.recorded("trusted").is_some(),
        "the node in the 0775 directory did not run"
    );
    assert!(sandbox.recorded("planted").is_none());
}

/// A node nobody but its owner can replace is what runs; one anyone can
/// write is not, even in a directory that is fine.
#[test]
fn a_world_writable_node_file_is_not_run() {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    std::fs::set_permissions(
        sandbox.path("safe/node"),
        std::fs::Permissions::from_mode(0o757),
    )
    .unwrap();
    let said = sandbox.subject(&sandbox.path("safe").display().to_string());
    assert!(said.starts_with("err "), "{said}");
    assert!(said.contains("writable by others"), "{said}");
    assert!(sandbox.recorded("trusted").is_none());
}

#[test]
fn with_no_trusted_node_the_error_says_so_and_nothing_is_run() {
    let sandbox = Sandbox::new();
    sandbox.plant("work", "cwd");
    sandbox.plant("work/bin", "relative");
    sandbox.plant("unsafe", "unsafe");
    let path = format!(":./bin:.:{}:", sandbox.path("unsafe").display());
    let said = sandbox.subject(&path);
    for label in ["cwd", "relative", "unsafe"] {
        if let Some(seen) = sandbox.recorded(label) {
            panic!("the `{label}` node ran with PATH={path}, and saw:\n{seen}\n(subject: {said})");
        }
    }
    assert!(said.starts_with("err "), "expected an error, got: {said}");
    assert!(said.contains("no usable `node`"), "{said}");
}

#[test]
fn the_bridge_sees_only_the_allowlisted_environment() {
    let sandbox = Sandbox::new();
    sandbox.plant("safe", "trusted");
    let trusted = sandbox.path("safe").display().to_string();
    let unsafe_dir = sandbox.path("unsafe").display().to_string();
    let said = sandbox.subject(&format!(":./bin:{trusted}:/nonexistent:{unsafe_dir}"));
    assert_eq!(said, "ok items=0");
    let seen = sandbox.recorded("trusted").expect("the trusted node ran");
    let expected: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(names(&seen), expected, "the bridge was handed:\n{seen}");
    // Values too: the passphrase appears nowhere, and PATH is the one trusted
    // directory, not what was inherited.
    for secret in [PASSPHRASE, "operator-token-for-tests", "dummy-proxy-pass"] {
        assert!(!seen.contains(secret), "the bridge saw {secret}:\n{seen}");
    }
    assert!(
        seen.lines().any(|line| line == format!("PATH={trusted}")),
        "{seen}"
    );
}

#[test]
fn a_real_node_still_parses_under_the_reduced_environment() {
    let Some(real) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("node"))
            .find(|node| dir_is_absolute_and_has(node))
    }) else {
        eprintln!("skip: no node on PATH");
        return;
    };
    let sandbox = Sandbox::new();
    // The runner-like layout, with the real thing behind it: 0775 in the user's
    // own group. A shim rather than a symlink, because the node the machine has
    // may be one the rule refuses (a hosted CI image leaves its own world-writable);
    // what is under test is that real Node parses under the reduced environment.
    std::fs::set_permissions(sandbox.path("safe"), std::fs::Permissions::from_mode(0o775)).unwrap();
    {
        let shim = sandbox.path("safe").join("node");
        let _guard = WRITING_OR_FORKING
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        std::fs::write(
            &shim,
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", real.display()),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let dump = sandbox.path("out/real-node-env.json");
    std::fs::write(
        sandbox.path("work/parse.mjs"),
        format!(
            "import {{ writeFileSync }} from 'node:fs';\n\
             writeFileSync({dump:?}, JSON.stringify(Object.keys(process.env)));\n\
             process.stdout.write({EMPTY_DOCUMENT:?});\n",
            dump = dump.display().to_string()
        ),
    )
    .unwrap();
    let said = sandbox.subject(&format!(":./bin:{}", sandbox.path("safe").display()));
    assert_eq!(said, "ok items=0");
    let keys: BTreeSet<String> =
        serde_json::from_str::<BTreeSet<String>>(&std::fs::read_to_string(&dump).unwrap())
            .expect("the stand-in bridge wrote its environment's names")
            .into_iter()
            .filter(|name| !SHELL_OWN.contains(&name.as_str()))
            .collect();
    let allowed: BTreeSet<String> = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
        .map(String::from)
        .into();
    assert_eq!(keys, allowed);
}

fn dir_is_absolute_and_has(node: &Path) -> bool {
    node.is_absolute() && node.is_file()
}
