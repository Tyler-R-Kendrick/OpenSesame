//! The one place a shared session's reach is decided (ADR 0079).
//!
//! Everything a participant may do in a shared session passes through
//! [`Reach::of`]. It is deliberately not a helper anybody could forget to
//! call: the routes take a [`Reach`] rather than a principal, so a handler
//! that wants to act on somebody's behalf has to have asked first.
//!
//! Three properties this module exists to hold:
//!
//! **Deny by default.** Every path that does not find an authorizing grant
//! returns [`Reach::None`]. There is no fall-through, no "operator can do
//! anything" shortcut that skips the store, and no branch where an error
//! reading grants is treated as an absence of restriction — a failed read is
//! a denial, because the alternative is a database hiccup handing out access.
//!
//! **The transport is not an authorization surface.** ADR 0079 §6 says it
//! outright: a message arriving on a session channel is a request like any
//! other, not evidence its sender is allowed. Nothing here reads anything
//! that travelled over the channel; the caller's identity comes from the
//! Host's own authenticated request, and the grants come from the Host's own
//! store.
//!
//! **The operator's reach is a role, not an exemption.** A session's operator
//! manages the session — the roster, the invitations, the join requests —
//! which is what [`Reach::Operator`] means. It does not mean they read every
//! item in the vault through the session: for that they need a grant like
//! anybody else, or their own project membership, which is a different road
//! checked elsewhere. Conflating the two is how "manages the sharing" quietly
//! becomes "reads everything shared".

use chrono::{DateTime, Utc};
use opensesame_domain::PrincipalId;
use opensesame_storage::{Db, StoredSession};

/// What a caller may do in one session.
///
/// Ordered from most to least: an operator runs the session, a participant is
/// in it, and everybody else is outside it. `None` is the default rather than
/// a failure case — a caller with no standing gets it, and so does a caller
/// whose standing could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Runs the session: may invite, admit, refuse, grant and revoke.
    Operator,
    /// Holds at least one live grant on the session.
    Participant,
    /// No standing at all. A caller here is told the session does not exist
    /// rather than that they are not allowed into it, so the surface is not an
    /// oracle for which private sessions exist.
    None,
}

impl Reach {
    /// Decide a caller's standing in one session.
    ///
    /// A read failure resolves to [`Reach::None`] and is logged. The
    /// alternative — treating "could not tell" as "probably fine" — is how a
    /// transient database error becomes an authorization bypass.
    pub async fn of(
        db: &Db,
        session: &StoredSession,
        caller: PrincipalId,
        now: DateTime<Utc>,
    ) -> Self {
        if session.operator_principal_id == caller {
            return Self::Operator;
        }
        match db.active_grants_for(session.id, caller, now).await {
            Ok(grants) if grants.iter().any(|grant| grant.assert_active(now).is_ok()) => {
                Self::Participant
            }
            Ok(_) => Self::None,
            Err(error) => {
                tracing::warn!(%error, "could not read session grants; denying");
                Self::None
            }
        }
    }

    /// Whether this caller may manage the session.
    #[must_use]
    pub fn is_operator(&self) -> bool {
        matches!(self, Self::Operator)
    }

    /// Whether this caller may see the roster and the session's own detail.
    ///
    /// Note what is *not* here: a pending join requester. ADR 0079 §7 —
    /// admission precedes connection. Somebody who has asked to join sees that
    /// their request is pending and nothing else: no roster, no channel, no
    /// peer. That is what keeps a public session from handing the participant
    /// list to whoever asks for it.
    #[must_use]
    pub fn may_see_session(&self) -> bool {
        matches!(self, Self::Operator | Self::Participant)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pending_requester_is_not_a_participant() {
        // Reach has no variant for "asked to join", and that is the point:
        // admission precedes connection (ADR 0079 §7). Anybody who is not the
        // operator and holds no grant is `None`, whatever they have asked for.
        assert!(!Reach::None.may_see_session());
        assert!(!Reach::None.is_operator());
    }

    #[test]
    fn an_operator_manages_the_session_and_a_participant_does_not() {
        assert!(Reach::Operator.is_operator());
        assert!(Reach::Operator.may_see_session());
        assert!(!Reach::Participant.is_operator());
        assert!(Reach::Participant.may_see_session());
    }
}
