//! How `opensesame dev run --agent` ends when something signals it (ADR 0150).
//!
//! A supervisor, a CI cancel and `timeout` end a command with `SIGTERM`; a
//! hung-up terminal sends `SIGHUP`. The run is bounded by `opensesame`, so each
//! must end the child, the proxy and the plugin, and leave the status a shell
//! would give a process killed by that signal (128 + n). Ctrl-C reaches the
//! child through the terminal's process group and stays exactly as it was.
//!
//! The real `opensesame`, the plugin's TEST build and a child that goes through
//! the run's proxy, as in `proxied_run_e2e.rs`; run with
//! `scripts/test/proxied-run-test.sh`. Every bound below is a ceiling for a
//! loaded machine; the stop itself takes milliseconds.
#![cfg(unix)]

mod proxied_run_support;

use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::time::{Duration, Instant};

use proxied_run_support::common::ready;
use proxied_run_support::run::{RunOptions, Running};
use proxied_run_support::upstream::{self, Upstream};
use proxied_run_support::{sweep, Sandbox, HOST, SCOPED_LINE};

/// The most a stop that the child cooperates with may take.
const ENDS_WITHIN: Duration = Duration::from_secs(10);
/// How long a child that ignores the signal is given (`STOP_GRACE` in
/// `dev_supervise.rs`) before it is killed.
const GRACE: Duration = Duration::from_secs(5);

/// Kills what a failing test would otherwise leave running.
struct Reaper(Vec<u32>);

impl Drop for Reaper {
    fn drop(&mut self) {
        for pid in &self.0 {
            let pid = libc::pid_t::try_from(*pid).unwrap();
            // SAFETY: a plain system call; a pid that is gone is an error here.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// A run that is live: the child holds, the proxy accepts, the plugin runs.
struct Live<'a> {
    running: Running<'a>,
    child_pid: u32,
    proxy: String,
    _reaper: Reaper,
}

impl<'a> Live<'a> {
    fn start(
        sandbox: &'a Sandbox,
        upstream: &Upstream,
        tune: impl FnOnce(&mut RunOptions<'_>),
    ) -> Self {
        let mut options = RunOptions::new(Some(upstream), Vec::new());
        options.wait = true;
        tune(&mut options);
        let mut running = sandbox.spawn_run(&options);
        running.wait_ready();
        let child_pid = running.child_pid().expect("the child recorded its pid");
        let proxy = running.proxy_addr().expect("the run's proxy");
        // The controls: all three are up before anything is sent.
        assert!(TcpStream::connect(&proxy).is_ok(), "{proxy} accepts");
        assert!(sweep::alive(child_pid), "the child runs");
        if sweep::can_read_processes() {
            let plugin = sandbox.installed_plugin();
            assert_eq!(
                sweep::processes_running(&plugin).len(),
                1,
                "the plugin runs"
            );
        }
        let mut doomed = vec![running.pid(), child_pid];
        doomed.extend(plugin_pids(sandbox));
        Self {
            running,
            child_pid,
            proxy,
            _reaper: Reaper(doomed),
        }
    }

    /// The plugin's half of the run is over: no proxy, no plugin process, no
    /// run directory.
    fn plugin_is_gone(&self, sandbox: &Sandbox) -> bool {
        TcpStream::connect(&self.proxy).is_err()
            && plugin_pids(sandbox).is_empty()
            && sandbox.run_dirs().is_empty()
    }

    /// When `opensesame` did not wait for the plugin (it was killed, or died
    /// of Ctrl-C), the plugin ends on its own as its stdin closes: give it a
    /// moment.
    fn await_plugin(&self, sandbox: &Sandbox) {
        let deadline = Instant::now() + ENDS_WITHIN;
        while Instant::now() < deadline && !self.plugin_is_gone(sandbox) {
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// The run is over: no child, no proxy, no plugin, no run directory.
    fn assert_over(&self, sandbox: &Sandbox) {
        assert!(!sweep::alive(self.child_pid), "the child is still running");
        assert!(
            TcpStream::connect(&self.proxy).is_err(),
            "{} still accepts",
            self.proxy
        );
        if sweep::can_read_processes() {
            assert_eq!(plugin_pids(sandbox), Vec::<u32>::new(), "the plugin runs");
        }
        assert!(sandbox.run_dirs().is_empty(), "{:?}", sandbox.run_dirs());
        assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
    }
}

fn plugin_pids(sandbox: &Sandbox) -> Vec<u32> {
    sweep::processes_running(&sandbox.installed_plugin())
        .iter()
        .filter_map(|pid| pid.parse().ok())
        .collect()
}

/// Run until `opensesame` ends, panicking (and killing it) if it does not.
fn ends(live: &mut Live<'_>, bound: Duration, why: &str) -> (std::process::ExitStatus, Duration) {
    let started = Instant::now();
    let Some(status) = live.running.exits_within(bound) else {
        live.running.kill();
        panic!("opensesame was still running {bound:?} after {why}");
    };
    (status, started.elapsed())
}

fn ends_on(signal: i32, name: &str) {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut live = Live::start(&sandbox, &upstream, |o| o.signals = Some("record"));
    let out = live.running.out.clone();

    live.running.signal(signal);
    let (status, took) = ends(&mut live, ENDS_WITHIN, name);
    eprintln!("{name}: opensesame exited {status:?} after {took:?}");

    // First what the signal is for: nothing of the run is left, the child
    // included. Then the status a shell would report.
    live.assert_over(&sandbox);
    assert_eq!(status.code(), Some(128 + signal), "{status:?}");
    // The child was asked first (it wrote this on the signal), not just killed.
    assert!(
        out.join(format!("got-{name}")).exists(),
        "the child never got {name}"
    );
    let finished = live.running.finish();
    let stderr = finished.stderr();
    assert!(stderr.contains(name), "{stderr}");
    assert!(!stderr.contains("osr_"), "{stderr}");
    assert!(upstream.hits().is_empty(), "{:?}", upstream.hits());
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn sigterm_ends_the_child_the_proxy_and_the_plugin_and_exits_143() {
    ends_on(libc::SIGTERM, "SIGTERM");
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn sighup_ends_the_child_the_proxy_and_the_plugin_and_exits_129() {
    ends_on(libc::SIGHUP, "SIGHUP");
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_child_that_ignores_the_signal_is_killed_once_its_grace_is_up() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut live = Live::start(&sandbox, &upstream, |o| o.signals = Some("ignore"));
    let out = live.running.out.clone();

    live.running.signal(libc::SIGTERM);
    let (status, took) = ends(
        &mut live,
        GRACE + ENDS_WITHIN,
        "SIGTERM to a child that ignores it",
    );
    eprintln!("ignored SIGTERM: opensesame exited {status:?} after {took:?}");

    live.assert_over(&sandbox);
    assert!(
        took >= GRACE - Duration::from_millis(500),
        "the child was killed after {took:?}, not given its {GRACE:?}"
    );
    assert_eq!(status.code(), Some(143), "{status:?}");
    assert!(out.join("got-SIGTERM").exists(), "it was asked first");
    let stderr = live.running.finish().stderr();
    assert!(stderr.contains("killed"), "{stderr}");
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn ctrl_c_still_ends_opensesame_and_the_child_together() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    // What a terminal does: SIGINT to the whole foreground process group,
    // which holds opensesame and the child, never the plugin (its own group).
    let mut live = Live::start(&sandbox, &upstream, |o| o.own_group = true);
    live.running.signal_group(libc::SIGINT);
    let (status, _) = ends(&mut live, ENDS_WITHIN, "SIGINT to the group");
    assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?}");
    // The plugin is told by its stdin closing, a moment after.
    live.await_plugin(&sandbox);
    live.assert_over(&sandbox);
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn killing_opensesame_itself_ends_the_run_but_cannot_stop_the_child() {
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut live = Live::start(&sandbox, &upstream, |_| {});
    live.running.signal(libc::SIGKILL);
    let (status, _) = ends(&mut live, ENDS_WITHIN, "SIGKILL");
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");

    // The kernel closed the plugin's stdin: the run's credentials are gone.
    live.await_plugin(&sandbox);
    assert!(
        live.plugin_is_gone(&sandbox),
        "the plugin's run outlived opensesame"
    );
    // A process that is killed runs no handler, so nothing tells the child: it
    // is left running with a surrogate that no longer works. docs/operators/
    // proxied-run-quickstart.md says so; if this changes, change both.
    assert!(
        sweep::alive(live.child_pid),
        "the child outlived opensesame"
    );
}

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_sigint_sent_to_opensesame_alone_is_left_to_the_terminal() {
    // Only a terminal's Ctrl-C reaches the child (it signals the whole group).
    // `kill -INT <pid>` reaches opensesame alone, which keeps SIGINT's default
    // action so that Ctrl-C stays exactly as it was: the run ends and the child
    // does not. docs/operators/proxied-run-quickstart.md says so.
    let sandbox = ready();
    let upstream = upstream::spawn(HOST);
    let mut live = Live::start(&sandbox, &upstream, |_| {});
    live.running.signal(libc::SIGINT);
    let (status, _) = ends(&mut live, ENDS_WITHIN, "SIGINT");
    assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?}");
    live.await_plugin(&sandbox);
    assert!(live.plugin_is_gone(&sandbox));
    assert!(
        sweep::alive(live.child_pid),
        "the child outlived opensesame"
    );
}

/// A stand-in plugin that has the run spec and then never answers.
const SILENT_PLUGIN: &str = "#!/bin/sh\nIFS= read -r line\n: > \"$0.started\"\n\
    cat > /dev/null\n: > \"$0.ended\"\n";

#[test]
#[ignore = "needs the plugin's test build: scripts/test/proxied-run-test.sh"]
fn a_signal_while_the_plugin_starts_leaves_no_child_and_no_plugin() {
    let sandbox = Sandbox::new();
    let silent = sandbox.path("silent-plugin");
    std::fs::write(&silent, SILENT_PLUGIN).unwrap();
    std::fs::set_permissions(&silent, std::fs::Permissions::from_mode(0o755)).unwrap();
    // `$0` is where plugins install puts the copy, so the markers sit beside it.
    let installed = sandbox.install_plugin_from(&silent);
    let beside = |suffix: &str| {
        let mut name = installed.clone().into_os_string();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };
    sandbox.init_store();
    sandbox.seal(proxied_run_support::CONNECTION_ENTRY, &sandbox.token);
    sandbox.write_schema(SCOPED_LINE);

    let mut running = sandbox.spawn_run(&RunOptions::new(None, Vec::new()));
    let started = beside(".started");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !started.exists() {
        assert!(Instant::now() < deadline, "the plugin never got the spec");
        std::thread::sleep(Duration::from_millis(25));
    }
    // opensesame is now waiting for an answer that does not come, with no
    // child yet. SIGTERM ends it; the plugin sees its stdin close.
    running.signal(libc::SIGTERM);
    let Some(status) = running.exits_within(ENDS_WITHIN) else {
        running.kill();
        panic!("opensesame was still waiting for the plugin after SIGTERM");
    };
    assert!(
        status.signal() == Some(libc::SIGTERM) || status.code() == Some(143),
        "{status:?}"
    );
    let ended = beside(".ended");
    let deadline = Instant::now() + ENDS_WITHIN;
    while !ended.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(ended.exists(), "the plugin never saw its stdin close");
    assert!(
        !running.out.join("pid").exists(),
        "the child must not have started"
    );
    assert_eq!(sandbox.leaks(&sandbox.token), Vec::<String>::new());
}
