//! Watching the child of `opensesame dev run --agent` while the
//! surrogate-proxy plugin serves it (ADR 0150 §6.2).
//!
//! The person at this terminal is the one watching the run, so the plugin is
//! told the run is watched, and a `surrogate.misdirected` — a surrogate sent
//! to a host that is not its provider's, which only a loose copy explains —
//! has already revoked the run's credentials by the time its tripwire line
//! arrives here. This side finishes the job through the same mechanism, the
//! run lease's [`RunCredentials`]: it stops the child (the agent no longer
//! drives), ends the plugin's run with [`end_and_revoke`], says so on
//! stderr, and exits [`TRIPWIRE_EXIT`] whatever the child would have
//! returned. A login's outcome is reported and nothing else: a refused login
//! falls back to the person, never to another substitution.

use std::process::{Child, ExitStatus};
use std::sync::mpsc::TryRecvError;
use std::time::Duration;

use opensesame_session_observe::{end_and_revoke, RunCredentials};
use serde_json::Value;

use crate::dev_surrogate::SurrogateSession;

/// The exit status of a run a tripwire stopped: `EX_NOPERM`, distinct from
/// anything a child's own failure is likely to use.
pub(crate) const TRIPWIRE_EXIT: i32 = 77;

const POLL: Duration = Duration::from_millis(25);

/// How a supervised run ended.
#[derive(Debug)]
pub(crate) enum RunEnd {
    /// The child exited by itself.
    Exited(ExitStatus),
    /// A tripwire revoked the run and the child was stopped.
    Tripped { fence: String, revoked: usize },
}

impl RunEnd {
    /// Tell the person what stopped the run; nothing for a child that exited.
    pub(crate) fn report(&self) {
        if let Self::Tripped { fence, revoked } = self {
            eprintln!(
                "opensesame: {fence}: a surrogate from this run was sent to a host that is not \
                 its provider's; the run's surrogates are revoked ({revoked}) and the child is \
                 stopped"
            );
        }
    }

    /// The status this process exits with, or `None` for success.
    pub(crate) fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Exited(status) if status.success() => None,
            Self::Exited(status) => Some(status.code().unwrap_or(1)),
            Self::Tripped { .. } => Some(TRIPWIRE_EXIT),
        }
    }
}

/// Wait for `child`, acting on the plugin's events while it runs.
///
/// # Errors
///
/// When the child cannot be waited on.
pub(crate) fn supervise(
    child: &mut Child,
    session: Option<&SurrogateSession>,
) -> std::io::Result<RunEnd> {
    loop {
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
