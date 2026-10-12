use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::*;

/// Dispositions belong to the whole process and the tests run on many
/// threads: one test at a time, each starting from the default and putting
/// back whatever the runner had.
static SERIAL: Mutex<()> = Mutex::new(());

struct Dispositions {
    found: Vec<(i32, libc::sigaction)>,
    _serial: MutexGuard<'static, ()>,
}

impl Dispositions {
    /// Both signals at their default action, as a terminal starts a command.
    fn at_default() -> Self {
        let serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
        let found = unix::ENDING
            .iter()
            .map(|&signal| (signal, unix::swap(signal, None).unwrap()))
            .collect();
        for signal in unix::ENDING {
            set(signal, libc::SIG_DFL);
        }
        Self {
            found,
            _serial: serial,
        }
    }

    /// The action in place now.
    fn current(signal: i32) -> libc::sigaction {
        unix::swap(signal, None).unwrap()
    }
}

fn set(signal: i32, handler: libc::sighandler_t) {
    // SAFETY: `handler` is `SIG_DFL`, `SIG_IGN` or a function that only
    // stores to an atomic.
    assert_ne!(unsafe { libc::signal(signal, handler) }, libc::SIG_ERR);
}

impl Drop for Dispositions {
    fn drop(&mut self) {
        for (signal, found) in &self.found {
            unix::swap(*signal, Some(found)).unwrap();
        }
    }
}

/// Stands for whatever was in place before the run: it counts its calls.
static PREVIOUS_CALLS: AtomicU32 = AtomicU32::new(0);

extern "C" fn previous(_signal: libc::c_int) {
    PREVIOUS_CALLS.fetch_add(1, Ordering::SeqCst);
}

fn previous_handler() -> libc::sighandler_t {
    previous as extern "C" fn(libc::c_int) as libc::sighandler_t
}

fn raise(signal: i32) {
    // SAFETY: `raise` signals the calling thread; any handler runs before it
    // returns and only stores to an atomic.
    assert_eq!(unsafe { libc::raise(signal) }, 0);
}

#[test]
fn the_first_signal_that_ends_a_run_is_the_one_reported() {
    let _dispositions = Dispositions::at_default();
    let handlers = install().unwrap();
    assert_eq!(pending(), None, "nothing has been signalled");
    raise(libc::SIGHUP);
    assert_eq!(pending(), Some(libc::SIGHUP));
    raise(libc::SIGTERM);
    assert_eq!(pending(), Some(libc::SIGHUP), "the first one stands");
    handlers.release(true);
}

#[test]
fn signals_are_named_the_way_a_shell_names_them() {
    assert_eq!(name(libc::SIGTERM), "SIGTERM");
    assert_eq!(name(libc::SIGHUP), "SIGHUP");
    assert_eq!(name(libc::SIGKILL), "SIGKILL");
    assert_eq!(name(40), "signal 40");
}

#[test]
fn only_termination_and_hangup_end_a_run() {
    // Ctrl-C reaches the child through the terminal's process group, so
    // SIGINT stays with its default action.
    assert_eq!(unix::ENDING, [libc::SIGTERM, libc::SIGHUP]);
}

/// Set in the fresh process that [`ignoring`] starts.
const FRESH: &str = "OPENSESAME_SIGNAL_TEST_FRESH_PROCESS";

/// An ignored signal is inherited through an exec, and so is the ignore a
/// concurrent test would leave on the children it spawns: these cases run the
/// test again, alone, in a fresh process of this binary that is started with
/// `ignored` ignored, the way `nohup` starts a command. Returns `true` in that
/// fresh process, where the caller goes on to assert; in the first one it runs
/// the fresh process itself and asserts it passed.
fn ignoring(ignored: i32, test: &str) -> bool {
    if std::env::var_os(FRESH).is_some() {
        return true;
    }
    // The harness names tests from the crate root down.
    let path = module_path!().split_once("::").map_or("", |(_, rest)| rest);
    let exact = format!("{path}::{test}");
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &exact, "--test-threads=1"])
        .env(FRESH, "1");
    // SAFETY: only `signal`, which is async-signal-safe, runs between the fork
    // and the exec.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, move || {
            libc::signal(ignored, libc::SIG_IGN);
            Ok(())
        });
    }
    let output = command.output().unwrap();
    let report = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && report.contains("1 passed"),
        "{exact} in a fresh process:\n{report}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

/// In the fresh process: `ignored` is ignored, `other` is the run's.
fn ignored_signal_stays_ignored(ignored: i32, other: i32) {
    // SAFETY: a plain system call, in a process with this one test.
    unsafe { libc::signal(other, libc::SIG_DFL) };
    let handlers = install().unwrap();
    assert!(
        unix::is_ignored(&Dispositions::current(ignored)),
        "the run replaced an ignored signal"
    );
    raise(ignored);
    assert_eq!(
        pending(),
        None,
        "an ignored signal is not the run's to end on"
    );
    // The rule is per signal: the other one is still the run's.
    raise(other);
    assert_eq!(pending(), Some(other));
    handlers.release(true);
    assert!(
        unix::is_ignored(&Dispositions::current(ignored)),
        "still ignored once the run is over"
    );
}

#[test]
fn a_hangup_that_was_ignored_when_the_run_began_stays_ignored() {
    // `nohup` starts a command with SIGHUP ignored.
    let test = "a_hangup_that_was_ignored_when_the_run_began_stays_ignored";
    if ignoring(libc::SIGHUP, test) {
        ignored_signal_stays_ignored(libc::SIGHUP, libc::SIGTERM);
    }
}

#[test]
fn a_terminate_that_was_ignored_when_the_run_began_stays_ignored() {
    let test = "a_terminate_that_was_ignored_when_the_run_began_stays_ignored";
    if ignoring(libc::SIGTERM, test) {
        ignored_signal_stays_ignored(libc::SIGTERM, libc::SIGHUP);
    }
}

#[test]
fn giving_the_handlers_back_restores_what_they_replaced() {
    let _dispositions = Dispositions::at_default();
    set(libc::SIGTERM, previous_handler());
    PREVIOUS_CALLS.store(0, Ordering::SeqCst);
    let handlers = install().unwrap();
    assert_ne!(
        Dispositions::current(libc::SIGTERM).sa_sigaction,
        previous_handler(),
        "the run's handler is in place while it runs"
    );
    handlers.release(true);
    assert_eq!(
        Dispositions::current(libc::SIGTERM).sa_sigaction,
        previous_handler()
    );
    assert_eq!(
        Dispositions::current(libc::SIGHUP).sa_sigaction,
        libc::SIG_DFL,
        "the signal that had no handler has none again"
    );
    // A signal after the run reaches what was there, not the run's flag.
    raise(libc::SIGTERM);
    assert_eq!(PREVIOUS_CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn a_signal_the_run_did_not_answer_is_raised_again_when_the_handlers_go() {
    let _dispositions = Dispositions::at_default();
    set(libc::SIGTERM, previous_handler());
    PREVIOUS_CALLS.store(0, Ordering::SeqCst);
    let handlers = install().unwrap();
    raise(libc::SIGTERM);
    assert_eq!(pending(), Some(libc::SIGTERM), "recorded, not answered");
    assert_eq!(PREVIOUS_CALLS.load(Ordering::SeqCst), 0);
    handlers.release(false);
    assert_eq!(
        PREVIOUS_CALLS.load(Ordering::SeqCst),
        1,
        "the signal reached what was in place before the run"
    );
}

#[test]
fn a_signal_the_run_answered_is_not_raised_again() {
    let _dispositions = Dispositions::at_default();
    set(libc::SIGTERM, previous_handler());
    PREVIOUS_CALLS.store(0, Ordering::SeqCst);
    let handlers = install().unwrap();
    raise(libc::SIGTERM);
    handlers.release(true);
    assert_eq!(PREVIOUS_CALLS.load(Ordering::SeqCst), 0);
}

#[test]
fn dropping_the_handlers_gives_them_back_too() {
    // A run that ends in an error, or unwinds, never reaches `release`.
    let _dispositions = Dispositions::at_default();
    set(libc::SIGHUP, previous_handler());
    drop(install().unwrap());
    assert_eq!(
        Dispositions::current(libc::SIGHUP).sa_sigaction,
        previous_handler()
    );
}
