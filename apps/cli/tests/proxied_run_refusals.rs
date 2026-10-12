//! The runs of `opensesame dev run --agent` that must not start, or must start
//! without a surrogate (ADR 0150): a plugin that does not match its pin, a
//! token that is not there or cannot be read, a scope that was never declared,
//! a plugin that is off. Each leaves the child either unstarted or holding a
//! placeholder, and no printed line or file holds the token.
//!
//! Needs the plugin's test build, like `proxied_run_e2e.rs`; run it with
//! `scripts/test/proxied-run-test.sh`.
#![cfg(unix)]

mod proxied_run_support;

use proxied_run_support::common::{assert_placeholder, ready};
use proxied_run_support::run::RunOptions;
use proxied_run_support::{
    sweep, upstream, Sandbox, CONNECTION_ENTRY, HOST, PLUGIN_ENV, SCOPED_LINE,
};

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_plugin_installed_with_the_wrong_pin_installs_nothing() {
    let sandbox = Sandbox::new();
    let wrong = "0".repeat(64);
    let from = std::env::var(PLUGIN_ENV).expect("the test build of the plugin");
    let output = sandbox.cli(&[
        "plugins",
        "install",
        "surrogate-proxy",
        "--from",
        &from,
        "--sha256",
        &wrong,
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("sha256 mismatch"));
    let listed = sandbox.cli_ok(&["plugins", "list"]);
    let proxy = listed["plugins"]
        .as_array()
        .and_then(|all| all.iter().find(|p| p["id"] == "surrogate-proxy"))
        .expect("the catalog row");
    assert_eq!(proxy["installed"], false, "{listed}");
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn with_no_sealed_entry_the_run_keeps_its_placeholder_and_says_where_to_store_one() {
    let guidance = "VERCEL_TOKEN has no token to redeem: store one with \
                    'opensesame pass insert connections/acme/vercel'";
    // A store that holds other entries, and no store at all.
    for with_store in [true, false] {
        let sandbox = Sandbox::new();
        sandbox.install_plugin();
        if with_store {
            sandbox.init_store();
            // The dummy token is in the store, under another connection's name.
            sandbox.seal("connections/acme/other", &sandbox.token);
        }
        sandbox.write_schema(SCOPED_LINE);
        let upstream = upstream::spawn(HOST);
        let finished = sandbox.run(&RunOptions::new(Some(&upstream), Vec::new()));
        let stderr = finished.stderr();
        assert!(stderr.contains(guidance), "store: {with_store}: {stderr}");
        assert!(stderr.contains("delivering placeholders"), "{stderr}");
        assert_placeholder(&finished, &sandbox.token);
        assert!(upstream.hits().is_empty());
        assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
    }
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn with_the_plugin_off_the_token_is_never_read_and_the_run_says_the_plugin_exists() {
    let sandbox = ready();
    sandbox.cli_ok(&["plugins", "disable", "surrogate-proxy"]);
    // A passphrase that opens nothing: a run that touched the store would fail.
    let mut options = RunOptions::new(None, Vec::new());
    options.passphrase = "not-the-passphrase";
    let finished = sandbox.run(&options);
    let stderr = finished.stderr();
    assert!(
        stderr.contains("available as an optional plugin"),
        "{stderr}"
    );
    assert_placeholder(&finished, &sandbox.token);
}

/// A run asked for a surrogate that cannot be delivered fails, and the child
/// never starts: falling back to a placeholder would leave the person running
/// without surrogates and not knowing it.
fn assert_refused(sandbox: &Sandbox, finished: &proxied_run_support::run::Finished, said: &str) {
    assert_ne!(finished.code(), Some(0));
    assert!(finished.stderr().contains(said), "{}", finished.stderr());
    assert!(!finished.child_ran());
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_plugin_that_no_longer_matches_its_pin_fails_the_run() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(sandbox.installed_plugin())
        .unwrap();
    std::io::Write::write_all(&mut file, b"tampered").unwrap();
    let finished = sandbox.run(&RunOptions::new(Some(&upstream), Vec::new()));
    assert_refused(&sandbox, &finished, "no longer matches its install pin");
    assert!(upstream.hits().is_empty());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn an_entry_the_store_will_not_open_for_fails_the_run_naming_the_entry() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut options = RunOptions::new(Some(&upstream), Vec::new());
    options.passphrase = "not-the-passphrase";
    let finished = sandbox.run(&options);
    assert_refused(&sandbox, &finished, CONNECTION_ENTRY);
    assert!(upstream.hits().is_empty());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn paths_without_methods_fails_the_schema_and_says_what_to_add() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    sandbox.write_schema(
        "VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token, \
         paths=\"/v2/user\")",
    );
    let finished = sandbox.run(&RunOptions::new(Some(&upstream), Vec::new()));
    // The message the person reads has been through the log scrubber: the
    // variable and the fix both have to survive it.
    assert_refused(&sandbox, &finished, "VERCEL_TOKEN cannot be delivered");
    assert!(
        finished
            .stderr()
            .contains("paths= needs methods= beside it"),
        "{}",
        finished.stderr()
    );
    assert!(upstream.hits().is_empty());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn an_entry_with_no_declared_path_fails_the_run_and_issues_nothing() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    sandbox.write_schema(
        "VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token)",
    );
    let finished = sandbox.run(&RunOptions::new(Some(&upstream), Vec::new()));
    assert_refused(&sandbox, &finished, "VERCEL_TOKEN has no bounded scope");
    assert!(upstream.hits().is_empty());
}

// ---------------------------------------------------------------------------
// the sweep's own control
// ---------------------------------------------------------------------------

#[test]
fn the_file_sweep_finds_a_planted_value_and_only_that() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("nested")).unwrap();
    std::fs::write(
        dir.path().join("nested/planted"),
        "x vtok_dummy_marker_planted y",
    )
    .unwrap();
    std::fs::write(dir.path().join("clean"), "nothing here").unwrap();
    let found = sweep::files_naming(dir.path(), "vtok_dummy_marker_planted");
    assert_eq!(found, [dir.path().join("nested/planted")]);
}
