//! Watching the child of `opensesame dev run` while it runs, and ending it.
//!
//! With the surrogate-proxy plugin serving an `--agent` run (ADR 0150 §6.2),
//! the person at this terminal is the one watching it, so the plugin is told
//! the run is watched, and a `surrogate.misdirected` — a surrogate sent to a
//! host that is not its provider's, which only a loose copy explains — has
//! already revoked the run's credentials by the time its tripwire line arrives
//! here. This side finishes the job through the same mechanism, the run
//! lease's [`RunCredentials`]: it stops the child (the agent no longer
//! drives), ends the plugin's run with [`end_and_revoke`], says so on
//! stderr, and exits [`TRIPWIRE_EXIT`] whatever the child would have
//! returned. A login's outcome is reported and nothing else: a refused login
//! falls back to the person, never to another substitution.
//!
//! The run is also bound to this process. `SIGTERM` and `SIGHUP`
//! ([`crate::dev_run::signal`]) end it the same way, with a courtesy the
//! tripwire does not give: the run's credentials go first, then the child is
//! sent the signal and has [`STOP_GRACE`] to leave before it is killed, and
//! the plugin is waited for. The exit status is the conventional `128 + n`
//! once the child is gone, whatever the child itself returned. That holds with
//! or without the plugin: a plain `dev run` child is stopped too. The signal
//! handlers are the run's alone: they go back as soon as the child is gone, so
//! a signal that comes while the plugin is waited for ends this process as it
//! always did.

use std::io::Write as _;
use std::process::{Child, Command, ExitStatus};
use std::sync::mpsc::TryRecvError;
use std::time::{Duration, Instant};

use opensesame_session_observe::{end_and_revoke, RunCredentials};
use serde_json::Value;

use crate::dev_run::signal;
use crate::dev_surrogate::SurrogateSession;

/// The exit status of a run a tripwire stopped: `EX_NOPERM`, distinct from
/// anything a child's own failure is likely to use.
pub(crate) const TRIPWIRE_EXIT: i32 = 77;

/// How long a child has to leave after the signal that ended the run before
/// it is killed.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(5);

const POLL: Duration = Duration::from_millis(25);

/// How a supervised run ended.
#[derive(Debug)]
pub(crate) enum RunEnd {
    /// The child exited by itself.
    Exited(ExitStatus),
    /// A tripwire revoked the run and the child was stopped.
    Tripped { fence: String, revoked: usize },
    /// This process was told to stop: the run was revoked and the child
    /// stopped, killed if it would not leave. `child_started` is false when
    /// the signal came before the child was spawned.
    Signalled {
        signal: i32,
        revoked: usize,
        killed: bool,
        child_started: bool,
    },
}

impl RunEnd {
    /// Tell the person what stopped the run; nothing for a child that exited.
    pub(crate) fn report(&self) {
        match self {
            Self::Exited(_) => {}
            Self::Tripped { fence, revoked } => eprintln!(
                "opensesame: {fence}: a surrogate from this run was sent to a host that is not \
                 its provider's; the run's surrogates are revoked ({revoked}) and the child is \
                 stopped"
            ),
            Self::Signalled {
                signal,
                revoked,
                killed,
                child_started,
            } => {
                // A hung-up terminal cannot be written to, and a failed write
                // here must not turn the status into a panic's.
                let line = signalled_line(*signal, *revoked, *killed, *child_started);
                let _ = writeln!(std::io::stderr(), "{line}");
            }
        }
    }

    /// The status this process exits with, or `None` for success.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Exited(status) if status.success() => None,
            Self::Exited(status) => Some(status.code().unwrap_or(1)),
            Self::Tripped { .. } => Some(TRIPWIRE_EXIT),
            Self::Signalled { signal, .. } => Some(128 + signal),
        }
    }
}

/// What `opensesame` says when a signal ended the run. No value is in it: the
/// signal, how many surrogates were revoked, and what became of the child.
pub(crate) fn signalled_line(
    signal: i32,
    revoked: usize,
    killed: bool,
    child_started: bool,
) -> String {
    let name = signal::name(signal);
    let credentials = if revoked > 0 {
        format!(" and its surrogates are revoked ({revoked})")
    } else {
        String::new()
    };
    let child = match (child_started, killed) {
        (false, _) => "; the child was not started".to_owned(),
        (true, true) => format!(
            "; the child did not leave within {}s and was killed",
            STOP_GRACE.as_secs()
        ),
        (true, false) => "; the child is stopped".to_owned(),
    };
    format!("opensesame: {name}: the run is ended{credentials}{child}")
}

/// Start `command` as the run's child and watch it, until it exits, a
/// tripwire stops it, or this process is told to stop.
///
/// # Errors
///
/// When the signal handlers cannot be installed, the child cannot be started,
/// or it cannot be waited on.
pub(crate) fn run(
    command: &mut Command,
    session: Option<&SurrogateSession>,
) -> std::io::Result<RunEnd> {
    let handlers = signal::install()?;
    let end = run_until(command, session, &signal::pending, STOP_GRACE);
    // The child is gone and nothing reads the flag any more, yet the caller
    // drops the session next and that waits for the plugin to leave, up to
    // 5 s: give the signals back first, so one that comes now ends this
    // process as it would have before the run began. A stop this process made
    // itself, on a signal or a tripwire, has already answered whatever came in;
    // any other end has not, and what arrived is raised again.
    handlers.release(matches!(
        end,
        Ok(RunEnd::Signalled { .. } | RunEnd::Tripped { .. })
    ));
    end
}

/// [`run`] with the source of the stopping signal and the grace given.
///
/// # Errors
///
/// As [`run`], bar the handlers.
pub(crate) fn run_until(
    command: &mut Command,
    session: Option<&SurrogateSession>,
    interrupt: &dyn Fn() -> Option<i32>,
    grace: Duration,
) -> std::io::Result<RunEnd> {
    // A signal that came while the plugin was starting is honoured before the
    // child exists, not after it has been given an environment to use.
    if let Some(signal) = interrupt() {
        let revoked = revoke(session);
        return Ok(RunEnd::Signalled {
            signal,
            revoked,
            killed: false,
            child_started: false,
        });
    }
    let mut child = command.spawn()?;
    supervise_until(&mut child, session, interrupt, grace)
}

/// Wait for `child`, acting on the plugin's events while it runs.
///
/// # Errors
///
/// When the child cannot be waited on.
#[cfg(all(test, unix))]
pub(crate) fn supervise(
    child: &mut Child,
    session: Option<&SurrogateSession>,
) -> std::io::Result<RunEnd> {
    supervise_until(child, session, &|| None, STOP_GRACE)
}

/// [`supervise`] that also ends the run when `interrupt` names a signal.
///
/// # Errors
///
/// When the child cannot be waited on.
pub(crate) fn supervise_until(
    child: &mut Child,
    session: Option<&SurrogateSession>,
    interrupt: &dyn Fn() -> Option<i32>,
    grace: Duration,
) -> std::io::Result<RunEnd> {
    loop {
        if let Some(signal) = interrupt() {
            return interrupted(child, session, signal, grace);
        }
        if let Some(session) = session {
            if let Some(end) = drain(child, session)? {
                return Ok(end);
            }
        }
        if let Some(status) = child.try_wait()? {
            // A tripwire the child raised just before it exited still counts.
            if let Some(end) = session.map(|s| drain(child, s)).transpose()?.flatten() {
                return Ok(end);
            }
            return Ok(RunEnd::Exited(status));
        }
        std::thread::sleep(POLL);
    }
}

/// The run's credentials, revoked and the plugin's run ended; how many.
fn revoke(session: Option<&SurrogateSession>) -> usize {
    session.map_or(0, |session| {
        let ended: &dyn RunCredentials = session;
        end_and_revoke(session.run_id(), ended)
    })
}

/// This process was told to stop. The credentials go first, so that nothing
/// the child does while it winds down can spend them; then the child is asked
/// to leave, and killed if it will not.
fn interrupted(
    child: &mut Child,
    session: Option<&SurrogateSession>,
    signal: i32,
    grace: Duration,
) -> std::io::Result<RunEnd> {
    let revoked = revoke(session);
    let mut killed = false;
    if child.try_wait()?.is_none() {
        signal::deliver(child, signal);
        let deadline = Instant::now() + grace;
        while child.try_wait()?.is_none() {
            if Instant::now() >= deadline {
                signal::deliver(child, signal::KILL);
                killed = true;
                break;
            }
            std::thread::sleep(POLL);
        }
        let _ = child.wait()?;
    }
    Ok(RunEnd::Signalled {
        signal,
        revoked,
        killed,
        child_started: true,
    })
}

/// Handle every event waiting; a tripwire ends the run.
fn drain(child: &mut Child, session: &SurrogateSession) -> std::io::Result<Option<RunEnd>> {
    loop {
        let event = match session.events().try_recv() {
            Ok(event) => event,
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(None),
        };
        match event["event"].as_str() {
            Some("tripwire") => return tripped(child, session, &event).map(Some),
            Some("login") => report_login(&event),
            _ => {}
        }
    }
}

fn tripped(
    child: &mut Child,
    session: &SurrogateSession,
    event: &Value,
) -> std::io::Result<RunEnd> {
    let fence = event["fence"].as_str().unwrap_or("surrogate.misdirected");
    let revoked = event["revoked"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(0);
    // The agent stops driving first, then the plugin's run ends.
    if child.try_wait()?.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait()?;
    let ended: &dyn RunCredentials = session;
    end_and_revoke(session.run_id(), ended);
    Ok(RunEnd::Tripped {
        fence: fence.to_owned(),
        revoked,
    })
}

fn report_login(event: &Value) {
    let var = event["env_var"].as_str().unwrap_or("a login");
    match event["outcome"].as_str() {
        Some("substituted") => eprintln!("opensesame: {var}: signed in with a surrogate"),
        Some("refused") => eprintln!(
            "opensesame: {var}: login substitution refused ({}); it is not retried — sign in \
             by hand if the site still needs it",
            event["fence"].as_str().unwrap_or("surrogate.refused")
        ),
        _ => {}
    }
}

#[cfg(test)]
#[path = "dev_supervise_tests.rs"]
mod tests;
