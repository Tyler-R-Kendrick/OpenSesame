//! What a responder did, so the dispatcher can publish the matching event.

/// The result of a responder acting on a lifecycle event.
///
/// A responder that starts long work rather than finishing it answers
/// [`Outcome::started`]: the event's outcome is *not yet known*, and the run
/// itself publishes it on the same feed when it ends. The dispatcher
/// recognises the difference by [`Outcome::pending`], because a success
/// outcome resolves the alert an approaching deadline opened, and a run that
/// has only begun has fixed nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub succeeded: bool,
    pub detail: String,
    /// The work was handed to a tracked task; this is not its outcome.
    pub pending: bool,
}

impl Outcome {
    pub(crate) fn ok(detail: impl Into<String>) -> Self {
        Self {
            succeeded: true,
            detail: detail.into(),
            pending: false,
        }
    }

    pub(crate) fn failed(detail: impl Into<String>) -> Self {
        Self {
            succeeded: false,
            detail: detail.into(),
            pending: false,
        }
    }

    /// The responder started work that will report its own outcome.
    pub(crate) fn started(detail: impl Into<String>) -> Self {
        Self {
            succeeded: true,
            detail: detail.into(),
            pending: true,
        }
    }
}
