//! What the plugin tells its parent while a run is live: one JSON line on
//! stdout per event, after the reply.
//!
//! ```text
//! {"event":"tripwire","run_id","fence":"surrogate.misdirected","verdict":"park"|"suspend","revoked":N}
//! {"event":"login","run_id","env_var","outcome":"substituted"}
//! {"event":"login","run_id","env_var","outcome":"refused","fence":"surrogate.…"}
//! ```
//!
//! A tripwire line means the run's credentials are already revoked; the
//! parent's part is to stop the child and tell the person (ADR 0150 §6.2). A
//! refused login falls back to the person signing in some other way; the
//! plugin never retries substitution (§6.3). Every field is a run id, a
//! variable name the parent chose, a fixed code or a count: no line carries
//! a surrogate or a credential.

use std::sync::Arc;

use opensesame_session_observe::TripwireVerdict;
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::tripwire::{LoginEvent, LoginOutcome, RunObserver, Tripped};

/// The observer the proxy calls, feeding the serve loop's writer.
pub(crate) struct EventPipe {
    sender: UnboundedSender<Value>,
}

/// A pipe and the receiver the serve loop drains to stdout.
pub(crate) fn pipe() -> (Arc<EventPipe>, UnboundedReceiver<Value>) {
    let (sender, receiver) = unbounded_channel();
    (Arc::new(EventPipe { sender }), receiver)
}

impl RunObserver for EventPipe {
    fn tripped(&self, tripped: &Tripped) {
        let verdict = match tripped.verdict {
            TripwireVerdict::Park => "park",
            TripwireVerdict::Suspend => "suspend",
            TripwireVerdict::Continue => return,
        };
        let _ = self.sender.send(json!({
            "event": "tripwire",
            "run_id": tripped.run_id,
            "fence": tripped.event_type,
            "verdict": verdict,
            "revoked": tripped.revoked,
        }));
    }

    fn login(&self, event: &LoginEvent) {
        let line = match event.outcome {
            LoginOutcome::Substituted => json!({
                "event": "login",
                "run_id": event.run_id,
                "env_var": event.env_var,
                "outcome": "substituted",
            }),
            LoginOutcome::Refused(fence) => json!({
                "event": "login",
                "run_id": event.run_id,
                "env_var": event.env_var,
                "outcome": "refused",
                "fence": fence,
            }),
        };
        let _ = self.sender.send(line);
    }
}
