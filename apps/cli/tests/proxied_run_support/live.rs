//! A live run to signal: the child holds, the proxy accepts, the plugin runs,
//! and what is left of each once `opensesame` has ended.
//!
//! Shared by the files that send `opensesame` a signal
//! (`proxied_run_signals.rs`, `proxied_run_signal_edges.rs`).

use std::net::TcpStream;
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use super::run::{RunOptions, Running};
use super::upstream::Upstream;
use super::{sweep, Sandbox};

/// The most a stop that the child cooperates with may take.
pub const ENDS_WITHIN: Duration = Duration::from_secs(10);

/// Kills what a failing test would otherwise leave running.
pub struct Reaper(pub Vec<u32>);

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
pub struct Live<'a> {
    pub running: Running<'a>,
    pub child_pid: u32,
    pub proxy: String,
    _reaper: Reaper,
}

impl<'a> Live<'a> {
    pub fn start(
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
    pub fn plugin_is_gone(&self, sandbox: &Sandbox) -> bool {
        TcpStream::connect(&self.proxy).is_err()
            && plugin_pids(sandbox).is_empty()
            && sandbox.run_dirs().is_empty()
    }

    /// When `opensesame` did not wait for the plugin (it was killed, or died
    /// of Ctrl-C), the plugin ends on its own as its stdin closes: give it a
    /// moment.
    pub fn await_plugin(&self, sandbox: &Sandbox) {
        let deadline = Instant::now() + ENDS_WITHIN;
        while Instant::now() < deadline && !self.plugin_is_gone(sandbox) {
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// The run is over: no child, no proxy, no plugin, no run directory.
    pub fn assert_over(&self, sandbox: &Sandbox) {
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

pub fn plugin_pids(sandbox: &Sandbox) -> Vec<u32> {
    sweep::processes_running(&sandbox.installed_plugin())
        .iter()
        .filter_map(|pid| pid.parse().ok())
        .collect()
}

/// Run until `opensesame` ends, panicking (and killing it) if it does not.
pub fn ends(live: &mut Live<'_>, bound: Duration, why: &str) -> (ExitStatus, Duration) {
    ends_running(&mut live.running, bound, why)
}

/// [`ends`] for a run that is not a [`Live`].
pub fn ends_running(
    running: &mut Running<'_>,
    bound: Duration,
    why: &str,
) -> (ExitStatus, Duration) {
    let started = Instant::now();
    let Some(status) = running.exits_within(bound) else {
        running.kill();
        panic!("opensesame was still running {bound:?} after {why}");
    };
    (status, started.elapsed())
}
