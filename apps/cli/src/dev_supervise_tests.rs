#![cfg(unix)]

use std::os::unix::process::CommandExt as _;
use std::path::Path;
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
        other => panic!("the run was not stopped by the tripwire: {other:?}"),
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

// ---------------------------------------------------------------------------
// A signal to this process ends the run
// ---------------------------------------------------------------------------

const TERM: i32 = libc::SIGTERM;
const SHORT_GRACE: Duration = Duration::from_millis(400);

/// A stop request that arrives once `marker` exists, as a signal handler's
/// flag would: the tests cannot signal the test runner itself.
fn once_exists(marker: &Path) -> impl Fn() -> Option<i32> + '_ {
    move || marker.exists().then_some(TERM)
}

/// `sh -c <script>` with `$PIDFILE` the file the script writes its pid to,
/// atomically and after it is ready to be signalled.
fn script(dir: &Path, body: &str) -> Command {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(format!(
            "{body}; echo $$ > \"$PIDFILE.tmp\"; mv \"$PIDFILE.tmp\" \"$PIDFILE\"; exec sleep 30"
        ))
        .env("PIDFILE", dir.join("pid"));
    command
}

fn pid_in(dir: &Path) -> u32 {
    std::fs::read_to_string(dir.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Whether `pid` is gone: not running, a zombie waiting for init included.
fn gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with(['Z', 'X'])),
        Err(_) if Path::new("/proc/self").exists() => true,
        // SAFETY: signal 0 delivers nothing; it only checks that the pid exists.
        Err(_) => libc::pid_t::try_from(pid).is_ok_and(|pid| unsafe { libc::kill(pid, 0) } != 0),
    }
}

fn wait_until_gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !gone(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    gone(pid)
}

#[test]
fn a_signal_revokes_the_run_stops_the_child_and_exits_128_plus_it() {
    let (plugin, session) = session(QUIET_PLUGIN);
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let mut command = script(dir.path(), ":");
    let started = Instant::now();
    let end = run_until(
        &mut command,
        Some(&session),
        &once_exists(&pidfile),
        STOP_GRACE,
    )
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the child was stopped, not waited out"
    );
    match &end {
        RunEnd::Signalled {
            signal,
            revoked,
            killed,
            child_started,
        } => {
            assert_eq!(*signal, TERM);
            assert_eq!(*revoked, 1, "the one surrogate the plugin issued");
            assert!(!killed, "it left when asked");
            assert!(child_started);
        }
        other => panic!("not a signalled run: {other:?}"),
    }
    assert_eq!(end.exit_code(), Some(143));
    assert!(wait_until_gone(pid_in(dir.path())), "the child is gone");
    assert!(
        plugin.dir.path().join("ended").exists(),
        "the plugin's run was ended through RunCredentials"
    );
}

#[test]
fn a_child_that_ignores_the_signal_is_killed_once_its_grace_is_up() {
    // No plugin: a plain `dev run` child is stopped the same way.
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let mut command = script(dir.path(), "trap '' TERM");
    let started = Instant::now();
    let end = run_until(&mut command, None, &once_exists(&pidfile), SHORT_GRACE).unwrap();
    let took = started.elapsed();
    assert!(took >= SHORT_GRACE, "given its grace first: {took:?}");
    assert!(took < Duration::from_secs(10), "then killed: {took:?}");
    match &end {
        RunEnd::Signalled {
            killed, revoked, ..
        } => {
            assert!(killed);
            assert_eq!(*revoked, 0);
        }
        other => panic!("not a signalled run: {other:?}"),
    }
    assert_eq!(end.exit_code(), Some(143));
    assert!(wait_until_gone(pid_in(dir.path())), "the child is gone");
}

#[test]
fn a_signal_before_the_child_exists_starts_no_child_and_still_ends_the_run() {
    let (plugin, session) = session(QUIET_PLUGIN);
    let dir = tempfile::tempdir().unwrap();
    let ran = dir.path().join("ran");
    let mut command = Command::new("sh");
    command.arg("-c").arg(format!(": > {}", ran.display()));
    let end = run_until(&mut command, Some(&session), &|| Some(TERM), STOP_GRACE).unwrap();
    match &end {
        RunEnd::Signalled {
            revoked,
            child_started,
            ..
        } => {
            assert_eq!(*revoked, 1);
            assert!(!child_started);
        }
        other => panic!("not a signalled run: {other:?}"),
    }
    assert_eq!(end.exit_code(), Some(143));
    assert!(!ran.exists(), "the child must not have been started");
    assert!(plugin.dir.path().join("ended").exists());
}

#[test]
fn a_signal_right_after_the_child_starts_still_stops_it() {
    // None for the check before the spawn, the signal from then on: it landed
    // in the gap between that check and the loop's first look.
    let calls = std::cell::Cell::new(0_u32);
    let interrupt = || {
        calls.set(calls.get() + 1);
        (calls.get() > 1).then_some(libc::SIGHUP)
    };
    let mut command = Command::new("sleep");
    command.arg("30");
    let started = Instant::now();
    let end = run_until(&mut command, None, &interrupt, STOP_GRACE).unwrap();
    // `sleep 30` waited for would take 30 s; the bound is far under that and
    // far over what a machine running other builds can take to signal a child.
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the child was signalled, not waited for"
    );
    assert_eq!(end.exit_code(), Some(129));
    assert!(matches!(
        end,
        RunEnd::Signalled {
            child_started: true,
            killed: false,
            ..
        }
    ));
}

#[test]
fn a_child_that_leads_its_own_group_is_stopped_with_what_it_started() {
    let dir = tempfile::tempdir().unwrap();
    let grandchild = dir.path().join("grandchild");
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("sleep 30 & echo $! > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; wait")
        .arg("sh")
        .arg(&grandchild)
        .process_group(0)
        .spawn()
        .unwrap();
    let end = supervise_until(&mut child, None, &once_exists(&grandchild), STOP_GRACE).unwrap();
    let pid: u32 = std::fs::read_to_string(&grandchild)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let left = !wait_until_gone(pid);
    if left {
        // Do not leave it behind for the rest of the half minute.
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status();
    }
    assert_eq!(end.exit_code(), Some(143));
    assert!(!left, "the child's own descendant outlived the run");
}

#[test]
fn what_is_said_when_a_signal_ends_the_run() {
    assert_eq!(
        signalled_line(libc::SIGTERM, 2, false, true),
        "opensesame: SIGTERM: the run is ended and its surrogates are revoked (2); the child is \
         stopped"
    );
    let killed = signalled_line(libc::SIGHUP, 0, true, true);
    assert!(
        killed.contains("SIGHUP") && killed.contains("was killed"),
        "{killed}"
    );
    assert!(!killed.contains("revoked"), "{killed}");
    let early = signalled_line(libc::SIGTERM, 1, false, false);
    assert!(early.contains("the child was not started"), "{early}");
    for line in [&killed, &early] {
        assert!(
            !line.contains("osr_") && !line.contains("ostest_"),
            "{line}"
        );
    }
}
