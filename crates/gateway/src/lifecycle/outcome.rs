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

    /// The responder did not act because a run for the target is already held
    /// elsewhere, so nothing was rotated and nothing was learned.
    ///
    /// Not a success: the dispatcher publishes nothing for it (a "renewed"
    /// event would resolve the expiry alert for a rotation that never
    /// happened), and a policy lease released with it takes the failure path,
    /// so the policy backs off and is tried again rather than being left to
    /// lapse. Not a failure either: no `renewal.failed` is published, because
    /// the holder may yet rotate the target.
    pub(crate) fn held(detail: impl Into<String>) -> Self {
        Self {
            succeeded: false,
            detail: detail.into(),
            pending: true,
        }
    }
}
