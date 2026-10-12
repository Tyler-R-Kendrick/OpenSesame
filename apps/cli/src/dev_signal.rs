//! The signals that end an `opensesame dev run`, and how the child is told.
//!
//! A run is bounded by this process: when a supervisor, a CI cancel or
//! `timeout` ends it with `SIGTERM`, or a hung-up terminal with `SIGHUP`, the
//! child must not be left holding an environment whose surrogate is dead.
//! Both signals are therefore caught here once the run is about to start, and
//! [`crate::dev_run::supervise`] stops the child itself. Until then — while
//! the plugin is still starting — nothing but the plugin exists, it ends when
//! this process dies (its stdin closes), and the default action is right.
//!
//! `SIGINT` is not caught. From a terminal it reaches this process and the
//! child together, which is exactly what ends both; keeping it that way keeps
//! Ctrl-C exactly as it was.
//!
//! The handler only records the first signal in an atomic, which is
//! async-signal-safe. The supervise loop polls it.

#[cfg(unix)]
mod unix {
    use std::io;
    use std::process::Child;
    use std::sync::atomic::{AtomicI32, Ordering};

    /// The first signal of [`ENDING`] this process received, or 0.
    static PENDING: AtomicI32 = AtomicI32::new(0);

    /// The signals that end a run.
    pub(crate) const ENDING: [i32; 2] = [libc::SIGTERM, libc::SIGHUP];

    extern "C" fn note(signal: libc::c_int) {
        let _ = PENDING.compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Catch [`ENDING`], so that [`pending`] reports them instead of this
    /// process dying with the child still running.
    ///
    /// # Errors
    ///
    /// When the operating system refuses a handler: the run then does not
    /// start, because it could not promise to stop its child.
    pub(crate) fn install() -> io::Result<()> {
        for signal in ENDING {
            // SAFETY: `action` is a zeroed `sigaction` with its mask emptied
            // and a handler that only stores to a lock-free atomic, which is
            // async-signal-safe. `SA_RESTART` keeps other threads' blocking
            // calls from failing with `EINTR`.
            let refused = unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = note as extern "C" fn(libc::c_int) as libc::sighandler_t;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&raw mut action.sa_mask);
                libc::sigaction(signal, &raw const action, std::ptr::null_mut()) != 0
            };
            if refused {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// The first run-ending signal received since [`install`], if any.
    pub(crate) fn pending() -> Option<i32> {
        match PENDING.load(Ordering::SeqCst) {
            0 => None,
            signal => Some(signal),
        }
    }

    /// Send `signal` to a child that has not been waited on, and to its
    /// process group when it leads one of its own (a child that called
    /// `setsid` or `setpgid` owns that group, so the whole of it is the
    /// child's). A child in this process's own group is signalled alone: the
    /// group is also the shell's job, and a pipeline's other members.
    ///
    /// The child must not have been reaped, or its pid could name another
    /// process; every caller has just seen `try_wait` answer `None`.
    pub(crate) fn deliver(child: &mut Child, signal: i32) {
        let Ok(pid) = libc::pid_t::try_from(child.id()) else {
            return;
        };
        // SAFETY: plain system calls on an integer pid of a child this
        // process has not reaped.
        unsafe {
            if libc::getpgid(pid) == pid {
                libc::kill(-pid, signal);
            } else {
                libc::kill(pid, signal);
            }
        }
    }

    /// The conventional name of a signal that can end a run.
    pub(crate) fn name(signal: i32) -> String {
        match signal {
            libc::SIGTERM => "SIGTERM".to_owned(),
            libc::SIGHUP => "SIGHUP".to_owned(),
            libc::SIGKILL => "SIGKILL".to_owned(),
            other => format!("signal {other}"),
        }
    }

    /// The signal that cannot be caught or ignored.
    pub(crate) const KILL: i32 = libc::SIGKILL;
}

#[cfg(unix)]
pub(crate) use unix::{deliver, install, name, pending, KILL};

#[cfg(not(unix))]
mod other {
    use std::process::Child;

    pub(crate) const KILL: i32 = 9;

    pub(crate) fn install() -> std::io::Result<()> {
        Ok(())
    }

    pub(crate) fn pending() -> Option<i32> {
        None
    }

    pub(crate) fn deliver(child: &mut Child, _signal: i32) {
        // No signals to send: ending the child is all there is.
        let _ = child.kill();
    }

    pub(crate) fn name(signal: i32) -> String {
        format!("signal {signal}")
    }
}

#[cfg(not(unix))]
pub(crate) use other::{deliver, install, name, pending, KILL};

#[cfg(all(test, unix))]
#[path = "dev_signal_tests.rs"]
mod tests;
