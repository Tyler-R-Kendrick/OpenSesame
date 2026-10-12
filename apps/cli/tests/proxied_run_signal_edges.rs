//! The edges of how `opensesame dev run --agent` ends on a signal (ADR 0150),
//! beside the main cases of `proxied_run_signals.rs`:
//!
//! - a launcher that started `opensesame` with `SIGHUP` (or `SIGTERM`) ignored,
//!   as `nohup` does, keeps that: the run does not end on it;
//! - once the child is gone the signal handlers are given back, so a signal
//!   that arrives while `opensesame` waits for the plugin to leave kills it
//!   as it would have before the run began;
//! - the longest a signalled run takes is the plugin's 5 s to answer the
//!   revoke plus the child's 5 s grace.
//!
//! The real `opensesame` and the plugin's TEST build, as in
//! `proxied_run_e2e.rs`; the last two cases use a stand-in plugin that will not
//! leave when told to. Run with `scripts/test/proxied-run-test.sh`. Every
//! bound is a ceiling for a loaded machine.
#![cfg(unix)]

mod proxied_run_support;

use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use proxied_run_support::common::ready;
use proxied_run_support::live::{ends, ends_running, Live, Reaper, ENDS_WITHIN};
use proxied_run_support::run::{RunOptions, Running};
use proxied_run_support::upstream;
use proxied_run_support::{sweep, Sandbox, CONNECTION_ENTRY, HOST, SCOPED_LINE};

/// What `opensesame` waits for the plugin to answer a revoke, and then for the
/// child to leave (`EXIT_GRACE` in `dev_surrogate.rs`, `STOP_GRACE` in
/// `dev_supervise.rs`).
const PLUGIN_GRACE: Duration = Duration::from_secs(5);
const CHILD_GRACE: Duration = Duration::from_secs(5);

/// How long a run that must not end is watched.
const WATCHED: Duration = Duration::from_millis(1500);

fn name_of(signal: i32) -> &'static str {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGTERM => "SIGTERM",
        other => panic!("no name for signal {other}"),
    }
}

/// `opensesame` is started with `ignored` ignored: a signal of that kind is
/// not the run's to answer. The other one still ends it.
fn ignored_stays_ignored(ignored: i32, then: i32) {
    let (ignored_name, then_name) = (name_of(ignored), name_of(then));
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut live = Live::start(&sandbox, &upstream, |options| {
        options.signals = Some("record");
        options.ignore = vec![ignored];
    });
    let out = live.running.out.clone();

    live.running.signal(ignored);
    if let Some(status) = live.running.exits_within(WATCHED) {
        panic!(
            "{ignored_name} was ignored when opensesame started, and it still ended the run: \
             {status:?}\n{}",
            live.running.stderr()
        );
    }
    // The run is whole: the child, the proxy and the plugin are all still up.
    assert!(sweep::alive(live.child_pid), "the child was stopped");
    assert!(
        std::net::TcpStream::connect(&live.proxy).is_ok(),
        "{} no longer accepts",
        live.proxy
    );
    assert!(!live.plugin_is_gone(&sandbox), "the plugin's run ended");
    assert!(!out.join(format!("got-{ignored_name}")).exists());
    assert!(!live.running.stderr().contains(ignored_name));

    // The other signal is still the run's: one process, a rule per signal.
    live.running.signal(then);
    let (status, _) = ends(&mut live, ENDS_WITHIN, then_name);
    live.assert_over(&sandbox);
    assert_eq!(status.code(), Some(128 + then), "{status:?}");
    assert!(out.join(format!("got-{then_name}")).exists());
    let stderr = live.running.finish().stderr();
    assert!(stderr.contains(then_name), "{stderr}");
    assert!(!stderr.contains(ignored_name), "{stderr}");
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_run_started_under_nohup_does_not_end_on_a_hangup() {
    ignored_stays_ignored(libc::SIGHUP, libc::SIGTERM);
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_run_started_with_sigterm_ignored_does_not_end_on_it() {
    ignored_stays_ignored(libc::SIGTERM, libc::SIGHUP);
}

/// A stand-in plugin that answers the run spec and, when `opensesame` ends the
/// run by closing its stdin, does not leave: it notes that it was told
/// (`$0.closed`) and sleeps. `$0.pid` is its pid.
const WEDGED_PLUGIN: &str = "#!/bin/sh\necho $$ > \"$0.pid\"\nIFS= read -r line\n\
    printf '%s\\n' '{\"proxy_url\":\"http://u:p@127.0.0.1:9\",\"ca_pem_path\":\"/nonexistent/ca.pem\",\
    \"env\":{\"VERCEL_TOKEN\":\"osr_00000000000000000000000000000000\"},\"unserved\":[]}'\n\
    cat > /dev/null\n: > \"$0.closed\"\nexec sleep 60\n";

/// A run whose plugin will not leave, with its child holding.
struct Wedged<'a> {
    running: Running<'a>,
    child_pid: u32,
    plugin_pid: u32,
    closed: PathBuf,
    _reaper: Reaper,
}

fn beside(installed: &Path, suffix: &str) -> PathBuf {
    let mut name = installed.to_path_buf().into_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

impl<'a> Wedged<'a> {
    fn start(sandbox: &'a Sandbox, signals: Option<&'static str>) -> Self {
        let plugin = sandbox.path("wedged-plugin");
        std::fs::write(&plugin, WEDGED_PLUGIN).unwrap();
        std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let installed = sandbox.install_plugin_from(&plugin);
        sandbox.init_store();
        sandbox.seal(CONNECTION_ENTRY, &sandbox.token);
        sandbox.write_schema(SCOPED_LINE);

        let mut options = RunOptions::new(None, Vec::new());
        options.wait = true;
        options.signals = signals;
        let mut running = sandbox.spawn_run(&options);
        running.wait_ready();
        let child_pid = running.child_pid().expect("the child recorded its pid");
        let plugin_pid: u32 = std::fs::read_to_string(beside(&installed, ".pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        Self {
            running,
            child_pid,
            plugin_pid,
            closed: beside(&installed, ".closed"),
            _reaper: Reaper(vec![child_pid, plugin_pid]),
        }
    }

    /// Wait until `opensesame` has told the plugin the run is over.
    fn await_closing(&self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !self.closed.exists() {
            assert!(Instant::now() < deadline, "the plugin was never told");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_signal_while_opensesame_waits_for_the_plugin_to_leave_is_not_swallowed() {
    let sandbox = Sandbox::new();
    let mut run = Wedged::start(&sandbox, None);
    // The child leaves on its own. opensesame then closes the plugin's stdin
    // and waits up to PLUGIN_GRACE for it to go, which this one does not.
    run.running.go();
    run.await_closing();
    assert!(
        run.running.exits_within(Duration::ZERO).is_none(),
        "opensesame is already gone, so the window under test is closed:\n{}",
        run.running.stderr()
    );
    assert!(!sweep::alive(run.child_pid), "the child left on its own");

    // A SIGTERM now is the person or the supervisor saying stop. Without a
    // handler it kills opensesame at once; with the run's handler still
    // installed it was recorded for a loop that had ended, and opensesame
    // went on to wait out the plugin and exit with the child's status.
    let told = Instant::now();
    run.running.signal(libc::SIGTERM);
    let (status, _) = ends_running(&mut run.running, ENDS_WITHIN, "SIGTERM in the window");
    let took = told.elapsed();
    assert_eq!(
        status.signal(),
        Some(libc::SIGTERM),
        "SIGTERM after the child had left did not end opensesame ({status:?} after {took:?})"
    );
    assert!(
        took < PLUGIN_GRACE - Duration::from_secs(1),
        "SIGTERM ended opensesame after {took:?}, not at once"
    );
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_wedged_plugin_and_a_child_that_will_not_leave_make_the_worst_case_ten_seconds() {
    let sandbox = Sandbox::new();
    let mut run = Wedged::start(&sandbox, Some("ignore"));
    let worst = PLUGIN_GRACE + CHILD_GRACE;

    run.running.signal(libc::SIGTERM);
    let (status, took) = ends_running(&mut run.running, worst + ENDS_WITHIN, "the worst case");
    eprintln!("wedged plugin, child that ignores SIGTERM: exited {status:?} after {took:?}");

    // The revoke waited for the plugin, and only then was the child asked, so
    // the two waits add up. This is the bound docs/operators/
    // proxied-run-quickstart.md gives; if it moves, move both.
    assert!(
        took >= worst - Duration::from_millis(500),
        "ended after {took:?}: the plugin's {PLUGIN_GRACE:?} and the child's {CHILD_GRACE:?} \
         are not both waited for"
    );
    assert_eq!(status.code(), Some(143), "{status:?}");
    assert!(!sweep::alive(run.child_pid), "the child is still running");
    assert!(!sweep::alive(run.plugin_pid), "the plugin is still running");
    assert!(run.running.out.join("got-SIGTERM").exists(), "asked first");
    let stderr = run.running.stderr();
    assert!(
        stderr.contains("SIGTERM") && stderr.contains("killed"),
        "{stderr}"
    );
    assert!(!stderr.contains("osr_"), "{stderr}");
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}
