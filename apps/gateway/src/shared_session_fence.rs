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
//!
//! **Presence is read from the seat, not from the grants.** ADR 0079 derived
//! standing from whether somebody held a grant, which meant the only way to
//! put a person in a room was to wrap a key for them. Since a coordination
//! session is mostly people who need no key, standing is now a
//! [`opensesame_domain::SessionMembership`] and [`Reach::Observer`] is the
//! mode that holds nothing. A caller with no seat is [`Reach::None`] however
//! many grants name them: admission precedes connection (ADR 0079 §7), and a
//! grant row that arrived without a seat is a bug, not a back door.

use chrono::{DateTime, Utc};
use opensesame_domain::{
    PrincipalId, SessionGrant, SessionGrantId, SessionMode, SessionRole, VaultId, VaultItemId,
};
use opensesame_storage::{Db, StoredSession};

/// What a caller may do in one session.
///
/// Ordered from most to least: an operator runs the session, a participant may
/// hold reach in it, an observer is in the room holding nothing, and everybody
/// else is outside it. `None` is the default rather than a failure case — a
/// caller with no standing gets it, and so does a caller whose standing could
/// not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Runs the session: may invite, admit, refuse, grant, revoke and close.
    Operator,
    /// Seated as somebody who may hold grants. Whether they hold any, and what
    /// those reach, is a separate question asked of the grants themselves.
    Participant,
    /// Seated to coordinate, holding nothing.
    ///
    /// An observer sees the session and its roster and receives the events
    /// that name no vault. They are never the subject of a grant, so there is
    /// no arrangement of their standing that reaches an item.
    Observer,
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
    ///
    /// **A closed session has nobody in it but its operator.** That is what
    /// closing means, and enforcing it here rather than in each handler is
    /// what makes it true of every road at once — including the referenced
    /// grants closing deliberately leaves alive, which keep working on their
    /// own road and stop working through this session.
    pub async fn of(
        db: &Db,
        session: &StoredSession,
        caller: PrincipalId,
        now: DateTime<Utc>,
    ) -> Self {
        // The operator keeps their standing after the close so they can still
        // read what happened. It is a management role and has never been a
        // reach into the vault, so this hands over nothing.
        if session.operator_principal_id == caller {
            return Self::Operator;
        }
        if session.closed_at.is_some() {
            return Self::None;
        }
        let _ = now;
        match db.session_membership(session.id, caller).await {
            Ok(Some(seat)) if seat.is_active() => match seat.mode {
                SessionMode::Participant => Self::Participant,
                SessionMode::Observer => Self::Observer,
            },
            Ok(_) => Self::None,
            Err(error) => {
                tracing::warn!(%error, "could not read session standing; denying");
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
        matches!(self, Self::Operator | Self::Participant | Self::Observer)
    }

    /// Whether this caller's grants are worth asking about.
    ///
    /// Not "may read" — that stays [`SessionGrant::permits`]'s question, asked
    /// of the grants themselves. This is the standing that makes the question
    /// meaningful at all, and the reason it exists is [`Reach::Observer`]: an
    /// observer holds no grants by construction, so consulting them would
    /// always answer no, and a refusal *before* the lookup turns that from a
    /// happy accident into a rule. If a grant ever names an observer — a
    /// direct database write, a restore from an older shape — this is what
    /// still denies it.
    ///
    /// The operator is included, and that does not widen anything: their
    /// grants are consulted like anybody's, and an operator who granted
    /// themselves nothing reaches nothing.
    #[must_use]
    pub fn may_hold_reach(&self) -> bool {
        matches!(self, Self::Operator | Self::Participant)
    }

    /// Whether this caller may manage who is in the session and close it.
    #[must_use]
    pub fn may_admit(&self) -> bool {
        self.is_operator()
    }
}

/// Whether some live grant lets `caller` do `wanted` to one item, and which.
///
/// Returns the authorizing grant's id so a receipt can name it. Deny by
/// default: an empty set and a set where nothing matches are the same answer.
///
/// This asks [`SessionGrant::permits`] rather than re-deriving its parts. The
/// subject, the clock, the role and the scope are checked together in the
/// domain, where forgetting one of them is not possible; a fence that unpacked
/// them here would be a second implementation free to drift.
pub(crate) fn authorizing_grant(
    grants: &[SessionGrant],
    caller: PrincipalId,
    vault_id: VaultId,
    item_id: VaultItemId,
    wanted: SessionRole,
    now: DateTime<Utc>,
) -> Option<SessionGrantId> {
    grants
        .iter()
        .find(|grant| grant.permits(caller, vault_id, item_id, wanted, now))
        .map(|grant| grant.id)
}

#[cfg(test)]
#[path = "shared_session_fence/tests.rs"]
mod tests;
