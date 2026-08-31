use serde::{Deserialize, Serialize};
use thiserror::Error;

/// How a would-be viewer stands to the credential the run is rotating.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum ViewerRelation {
    /// The principal whose credential this is.
    CredentialOwner,
    /// Holds a delegated grant to *use* the connection.
    ///
    /// Denied. A use-grant is authority over a credential; a session view is an
    /// authenticated view of the account behind it — balances, addresses,
    /// message subjects, security settings — which no delegation covered
    /// (ADR 0076 §5). Attenuation runs the other way: a narrower grant cannot
    /// acquire a wider read.
    Delegate,
    /// Deployment operator or support.
    ///
    /// Denied. Ops legitimately needs to know a run parked and why; it does not
    /// need to watch somebody's account, and a live view is exactly the surface
    /// that turns a support request into shoulder-surfing.
    Operator,
    /// An MCP or `WebMCP` tool call.
    ///
    /// Denied structurally, extending ADR 0076 §10's exclusion of
    /// `rotations.recording_read` to the live tail of the same log. The stream
    /// is the recording.
    AgentSurface,
}

/// What the viewer is asking for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum Attachment {
    /// Follow the stream.
    View,
    /// Take the page.
    Control,
}

/// Whether the viewer has authenticated recently enough to drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum StepUp {
    Fresh,
    Stale,
}

/// Why an attach was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachRefusal {
    #[error("session observation is not an agent surface")]
    AgentSurfacesExcluded,
    #[error("only the credential's owner may observe its run")]
    NotTheOwner,
    #[error("taking control requires a fresh step-up")]
    StepUpRequired,
    #[error("another viewer holds the control lease")]
    LeaseHeld,
}

/// Decide one attach.
///
/// View and control are separated on purpose. Viewing is already gated by
/// cryptography — the log is sealed to the owner's viewer key, so a client
/// with a locked vault cannot read it whatever this function says. Control is
/// not: it is a live action inside an authenticated session at a third party,
/// on the far side of a channel that a stolen browser tab would also reach, so
/// it takes a fresh step-up on top.
///
/// `lease_held_by_other` is passed rather than derived because this crate holds
/// no viewer identity: [`crate::ControlLease`] tracks *whether* control has
/// moved, and the caller knows *who* moved it. Splitting the two means an
/// entitlement bug cannot produce two drivers and a state bug cannot produce an
/// unentitled one.
///
/// # Errors
///
/// [`AttachRefusal`] naming the reason. Refusals are typed rather than boolean
/// so a receipt can record which one fired.
pub fn authorize_attach(
    relation: ViewerRelation,
    attachment: Attachment,
    step_up: StepUp,
    lease_held_by_other: bool,
) -> Result<(), AttachRefusal> {
    match relation {
        ViewerRelation::AgentSurface => return Err(AttachRefusal::AgentSurfacesExcluded),
        ViewerRelation::Delegate | ViewerRelation::Operator => {
            return Err(AttachRefusal::NotTheOwner)
        }
        ViewerRelation::CredentialOwner => {}
    }
    if attachment == Attachment::Control {
        if step_up == StepUp::Stale {
            return Err(AttachRefusal::StepUpRequired);
        }
        if lease_held_by_other {
            return Err(AttachRefusal::LeaseHeld);
        }
    }
    // A second window belonging to the same person is still just watching, so
    // viewing itself is never contended.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(attachment: Attachment, step_up: StepUp) -> Result<(), AttachRefusal> {
        authorize_attach(ViewerRelation::CredentialOwner, attachment, step_up, false)
    }

    #[test]
    fn nobody_but_the_owner_watches_a_run() {
        for relation in [ViewerRelation::Delegate, ViewerRelation::Operator] {
            assert_eq!(
                authorize_attach(relation, Attachment::View, StepUp::Fresh, false),
                Err(AttachRefusal::NotTheOwner),
                "{relation:?}"
            );
        }
    }

    #[test]
    fn agent_surfaces_are_refused_before_anything_else_is_considered() {
        for attachment in [Attachment::View, Attachment::Control] {
            assert_eq!(
                authorize_attach(
                    ViewerRelation::AgentSurface,
                    attachment,
                    StepUp::Fresh,
                    false
                ),
                Err(AttachRefusal::AgentSurfacesExcluded)
            );
        }
    }

    #[test]
    fn viewing_needs_no_step_up_but_driving_does() {
        assert_eq!(owner(Attachment::View, StepUp::Stale), Ok(()));
        assert_eq!(
            owner(Attachment::Control, StepUp::Stale),
            Err(AttachRefusal::StepUpRequired)
        );
        assert_eq!(owner(Attachment::Control, StepUp::Fresh), Ok(()));
    }

    #[test]
    fn one_driver_at_a_time_but_any_number_of_watchers() {
        assert_eq!(
            authorize_attach(
                ViewerRelation::CredentialOwner,
                Attachment::Control,
                StepUp::Fresh,
                true
            ),
            Err(AttachRefusal::LeaseHeld)
        );
        assert_eq!(
            authorize_attach(
                ViewerRelation::CredentialOwner,
                Attachment::View,
                StepUp::Fresh,
                true
            ),
            Ok(())
        );
    }

    #[test]
    fn a_stale_step_up_is_reported_before_contention() {
        // Telling someone the lease is taken when they were not going to be
        // allowed to drive anyway leaks who else is on the account.
        assert_eq!(
            authorize_attach(
                ViewerRelation::CredentialOwner,
                Attachment::Control,
                StepUp::Stale,
                true
            ),
            Err(AttachRefusal::StepUpRequired)
        );
    }
}
