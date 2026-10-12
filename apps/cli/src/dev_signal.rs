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
//! The run takes only what it was given. A signal that was ignored when the
//! run began (`nohup` starts a command with `SIGHUP` ignored) stays ignored:
//! the launcher asked for this process to outlive a hangup, and a run that
//! ended on one would undo that. And the handlers are the run's alone: they
//! are given back, with what they replaced, as soon as the child is gone, so a
//! signal that comes while this process waits for the plugin to leave ends it
//! as it would have before the run began.
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

    /// The handlers of a run, and what each replaced. Dropping puts it back.
    pub(crate) struct Handlers {
        saved: Vec<(i32, libc::sigaction)>,
    }

    /// Set the action of `signal` to `new`, or only read it for `None`, and
    /// return the action that was in place.
    pub(super) fn swap(signal: i32, new: Option<&libc::sigaction>) -> io::Result<libc::sigaction> {
        // SAFETY: `old` is a zeroed `sigaction` the call fills in, and `new`,
        // when there is one, is a fully initialised one.
        unsafe {
            let mut old: libc::sigaction = std::mem::zeroed();
            let new = new.map_or(std::ptr::null(), std::ptr::from_ref);
            if libc::sigaction(signal, new, &raw mut old) == 0 {
                Ok(old)
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }

    /// Whether `action` is `SIG_IGN`.
    pub(super) fn is_ignored(action: &libc::sigaction) -> bool {
        action.sa_flags & libc::SA_SIGINFO == 0 && action.sa_sigaction == libc::SIG_IGN
    }

    /// Catch [`ENDING`], so that [`pending`] reports them instead of this
    /// process dying with the child still running. A signal that is ignored
    /// now stays ignored and is never reported.
    ///
    /// # Errors
    ///
    /// When the operating system refuses a handler: the run then does not
    /// start, because it could not promise to stop its child. What was
    /// installed before the refusal is given back.
    pub(crate) fn install() -> io::Result<Handlers> {
        PENDING.store(0, Ordering::SeqCst);
        let mut handlers = Handlers { saved: Vec::new() };
        for signal in ENDING {
            if is_ignored(&swap(signal, None)?) {
                continue;
            }
            // SAFETY: `action` is a zeroed `sigaction` with its mask emptied
            // and a handler that only stores to a lock-free atomic, which is
            // async-signal-safe. `SA_RESTART` keeps other threads' blocking
            // calls from failing with `EINTR`.
            let action = unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = note as extern "C" fn(libc::c_int) as libc::sighandler_t;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&raw mut action.sa_mask);
                action
            };
            let replaced = swap(signal, Some(&action))?;
            handlers.saved.push((signal, replaced));
        }
        Ok(handlers)
    }

    impl Handlers {
        /// The child is gone and nothing reads the flag any more: put back
        /// what the handlers replaced. A signal they recorded that the run did
        /// not answer (`stopped` is false) is raised again, so that what is in
        /// place now decides what it does rather than nothing.
        pub(crate) fn release(self, stopped: bool) {
            let unanswered = if stopped { None } else { pending() };
            drop(self);
            if let Some(signal) = unanswered {
                // SAFETY: `raise` signals the calling thread and nothing else.
                unsafe { libc::raise(signal) };
            }
        }
    }

    impl Drop for Handlers {
        fn drop(&mut self) {
            for (signal, replaced) in self.saved.drain(..) {
                // Nothing to do about a refusal while giving back.
                let _ = swap(signal, Some(&replaced));
            }
        }
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

    /// Nothing to give back: there are no handlers.
    #[derive(Debug)]
    pub(crate) struct Handlers;

    impl Handlers {
        #[allow(clippy::unused_self)]
        pub(crate) fn release(self, _stopped: bool) {}
    }

    pub(crate) fn install() -> std::io::Result<Handlers> {
        Ok(Handlers)
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
