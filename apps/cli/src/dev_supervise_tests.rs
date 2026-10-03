#![cfg(unix)]

use std::process::Command;
use std::time::{Duration, Instant};

use super::*;
use crate::dev_surrogate::start;
use crate::dev_surrogate::tests::{installed, no_env, placeholder, NoStore};

/// A plugin that answers, then — as the real one does when a surrogate is
/// misdirected — reports a tripwire, and marks when its stdin closes.
const TRIPPING_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"GITHUB_TOKEN":"osr_00000000000000000000000000000000"},"unserved":[]}'
sleep 0.3
printf '%s\n' '{"event":"login","run_id":"r","env_var":"APP_PASSWORD","outcome":"refused","fence":"surrogate.unsupported"}'
printf '%s\n' '{"event":"tripwire","run_id":"r","fence":"surrogate.misdirected","verdict":"park","revoked":1}'
cat > /dev/null
: > "$here/ended"
"#;

/// A plugin that answers and says nothing more.
const QUIET_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"GITHUB_TOKEN":"osr_00000000000000000000000000000000"},"unserved":[]}'
cat > /dev/null
: > "$here/ended"
"#;

fn session(script: &str) -> (crate::dev_surrogate::tests::Plugin, SurrogateSession) {
    let plugin = installed(script, true, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let session = start(&entries, Some(&plugin.settings), &no_env, &NoStore)
        .unwrap()
        .expect("an active plugin");
    (plugin, session)
}

#[test]
fn a_tripwire_stops_the_child_ends_the_plugin_run_and_exits_non_zero() {
    let (plugin, session) = session(TRIPPING_PLUGIN);
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let started = Instant::now();
    let end = supervise(&mut child, Some(&session)).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the child was stopped, not waited out"
    );
    match &end {
        RunEnd::Tripped { fence, revoked } => {
            assert_eq!(fence, "surrogate.misdirected");
            assert_eq!(*revoked, 1);
        }
        RunEnd::Exited(status) => panic!("the run was not stopped: {status}"),
    }
    assert_eq!(end.exit_code(), Some(TRIPWIRE_EXIT));
    assert!(child.try_wait().unwrap().is_some(), "the child is gone");
    assert!(
        plugin.dir.path().join("ended").exists(),
        "the plugin's run was ended through RunCredentials"
    );
}

#[test]
fn a_run_without_a_tripwire_exits_as_its_child_did() {
    let (plugin, session) = session(QUIET_PLUGIN);
    let mut ok = Command::new("true").spawn().unwrap();
    let end = supervise(&mut ok, Some(&session)).unwrap();
    assert_eq!(end.exit_code(), None);
    let mut failing = Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap();
    assert_eq!(
        supervise(&mut failing, Some(&session)).unwrap().exit_code(),
        Some(3)
    );
    drop(session);
    assert!(plugin.dir.path().join("ended").exists());
}

#[test]
fn a_run_with_no_plugin_is_just_its_child() {
    let mut child = Command::new("sh").args(["-c", "exit 5"]).spawn().unwrap();
    assert_eq!(supervise(&mut child, None).unwrap().exit_code(), Some(5));
}
