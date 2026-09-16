//! Being in the room, and how a session's reach is tied to the session
//! (ADR 0079 §2, §7).
//!
//! ADR 0079 built presence out of grants: you were in a session because you
//! held reach into a vault through it, and [`crate::SessionGrant`] was the only
//! record that you were there at all. That is the right rule for a *sharing*
//! session and the wrong one for a **coordination** session, where most of the
//! people in the room are there to watch the work happen and never open an
//! item. Under the old shape the only way to seat them was to grant them
//! something, and a grant is a wrapped key — the one act ADR 0079 §3 says
//! cannot be taken back without re-keying. Seating an observer would therefore
//! have handed out, irrevocably, a key they had no use for.
//!
//! So this module separates the two questions that were one:
//!
//! - **Who is in the room** is a [`SessionMembership`], which carries a
//!   [`SessionMode`] and no scope, no role, and no key material of any kind.
//! - **What they may reach** stays [`crate::SessionGrant`], unchanged.
//!
//! [`SessionMode::Observer`] is the mode that holds nothing, and the rule that
//! makes it worth having is enforced rather than documented:
//! [`SessionMembership::assert_may_hold_grant`] refuses to let a grant be
//! minted for an observer at all. An operator who wants to give an observer
//! reach raises them to [`SessionMode::Participant`] first, which is a
//! deliberate act with a timestamp on it rather than a side effect of granting.
//!
//! The second thing here is [`GrantLink`], which answers a question ADR 0079
//! left implicit: when the session ends, what happens to the reach it carried?
//! Two answers, and they must not be confused —
//! [`GrantLink::LifecycleBound`] reach exists *because* the session does and
//! dies with it, while [`GrantLink::Referenced`] reach is a pointer at
//! something the holder already had by another road, which the session may
//! narrow and may never widen or outlive.

use crate::{DomainError, PrincipalId, SessionGrantId, SessionId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// How somebody is present in a session.
///
/// Two modes, and the distinction is about keys rather than about politeness.
/// An observer's presence is a row in a table; a participant's presence is a
/// row in a table *and* whatever grants the operator minted for them. There is
/// no third mode for "observer who can peek", because that is a participant
/// with a narrow grant, which the scope already expresses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// In the room, holding nothing.
    ///
    /// An observer sees that the session exists, who else is in it, and that
    /// work is happening. They are never wrapped a `ProjectCollectionKey` or
    /// an `ItemDataKey`, never appear as the subject of a grant, and never
    /// receive an event naming a vault or an item — not because the delivery
    /// path filters them out afterwards, but because they hold nothing for a
    /// filter to match on.
    Observer,
    /// In the room and able to hold grants.
    ///
    /// Being a participant is still not reach: it is *permission to be given*
    /// reach. A participant with no live grant reads nothing, exactly as an
    /// observer does. The difference is that granting one is allowed.
    Participant,
}

impl SessionMode {
    /// Whether somebody in this mode may be the subject of a session grant.
    #[must_use]
    pub fn may_hold_a_grant(self) -> bool {
        matches!(self, Self::Participant)
    }
}

/// One principal's seat in one session.
///
/// Keyed by the pair rather than by an id of its own: a principal is in a
/// session once or not at all, and a surrogate key would make "twice, in two
/// modes" representable. That contradiction is the one this type exists to
/// prevent, so it is not given a way to occur.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMembership {
    pub session_id: SessionId,
    pub principal_id: PrincipalId,
    pub mode: SessionMode,
    /// The operator who seated them. Never the member themselves — admission
    /// is the operator's act (ADR 0079 §7), and a self-admitted seat would be
    /// a join request that skipped the deciding.
    pub admitted_by_principal_id: PrincipalId,
    pub admitted_at: DateTime<Utc>,
    /// Set when they left, were removed, or the session closed. A seat is
    /// ended rather than deleted so the roster has a history.
    pub ended_at: Option<DateTime<Utc>>,
}

impl SessionMembership {
    /// Seat somebody.
    #[must_use]
    pub fn new(
        session_id: SessionId,
        principal_id: PrincipalId,
        mode: SessionMode,
        admitted_by_principal_id: PrincipalId,
        admitted_at: DateTime<Utc>,
    ) -> Self {
        Self {
            session_id,
            principal_id,
            mode,
            admitted_by_principal_id,
            admitted_at,
            ended_at: None,
        }
    }

    /// Whether this seat is still held.
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.ended_at.is_none()
    }

    /// Whether a grant may be minted for this member.
    ///
    /// The fence for the whole observer idea. It is asked where the grant is
    /// *made*, not where it is used, so an observer never has a key wrapped
    /// for them in the first place — which matters because ADR 0079 §3's
    /// revocation is re-keying, and a key wrapped by mistake stays wrapped.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionMembershipEnded`] for a seat that has been given
    /// up, and [`DomainError::SessionObserverHoldsNoGrant`] for an observer.
    pub fn assert_may_hold_grant(&self) -> Result<(), DomainError> {
        if !self.is_active() {
            return Err(DomainError::SessionMembershipEnded);
        }
        if !self.mode.may_hold_a_grant() {
            return Err(DomainError::SessionObserverHoldsNoGrant);
        }
        Ok(())
    }

    /// Give this member reach-bearing standing.
    ///
    /// Separate from granting on purpose. Raising somebody is the operator
    /// saying "this person may be given keys"; what they are then given is a
    /// second decision with its own scope and its own expiry. Collapsing the
    /// two would mean every grant silently promoted its subject.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionMembershipEnded`] for a seat already given up.
    pub fn raised_to_participant(self) -> Result<Self, DomainError> {
        if !self.is_active() {
            return Err(DomainError::SessionMembershipEnded);
        }
        Ok(Self {
            mode: SessionMode::Participant,
            ..self
        })
    }

    /// Take reach-bearing standing away, leaving the seat.
    ///
    /// Refused while the member still holds live grants, and the count is a
    /// parameter rather than something this type guesses at: an observer who
    /// still holds a wrapped key is the contradiction the mode exists to rule
    /// out, and lowering somebody into it would make the invariant a lie that
    /// every later check would have to re-test. The operator revokes first,
    /// which is the act that actually removes the reach.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionMembershipEnded`] for a seat already given up,
    /// and [`DomainError::SessionObserverHoldsNoGrant`] when live grants
    /// remain.
    pub fn lowered_to_observer(self, live_grants: usize) -> Result<Self, DomainError> {
        if !self.is_active() {
            return Err(DomainError::SessionMembershipEnded);
        }
        if live_grants > 0 {
            return Err(DomainError::SessionObserverHoldsNoGrant);
        }
        Ok(Self {
            mode: SessionMode::Observer,
            ..self
        })
    }

    /// Give up the seat. Idempotent, and never un-ends one: the first
    /// departure is the one that happened.
    #[must_use]
    pub fn ended(self, at: DateTime<Utc>) -> Self {
        if self.ended_at.is_some() {
            return self;
        }
        Self {
            ended_at: Some(at),
            ..self
        }
    }
}

/// What admitting a join request produced.
///
/// ADR 0079 §7 said admission *is* a grant, so that nobody could be admitted
/// "into the room with nothing". Coordination sessions make the first half of
/// that wrong and the second half more important: an observer genuinely is
/// admitted with nothing, so the rule is restated as **admission is a named
/// seat**. There is still no shape here for an admission that produced
/// neither — a decision carries one of these two, and the observer case is
/// something an operator chose rather than a field somebody left null.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "mode")]
pub enum Admission {
    /// Seated to coordinate. No grant, and so no key wrapped for them.
    Observer,
    /// Seated with reach, which is the grant admitting minted.
    Participant { grant_id: SessionGrantId },
}

impl Admission {
    /// The mode this admission seats somebody in.
    #[must_use]
    pub fn mode(self) -> SessionMode {
        match self {
            Self::Observer => SessionMode::Observer,
            Self::Participant { .. } => SessionMode::Participant,
        }
    }

    /// The grant it minted, if it minted one.
    #[must_use]
    pub fn grant_id(self) -> Option<SessionGrantId> {
        match self {
            Self::Observer => None,
            Self::Participant { grant_id } => Some(grant_id),
        }
    }
}

/// Why a session's reach exists, and therefore what ending the session does
/// to it.
///
/// The distinction is not bookkeeping. Closing a session that minted reach
/// must take that reach back, or "the session is over" means nothing; closing
/// a session that merely *pointed at* reach somebody already held must not, or
/// ending a meeting would revoke a colleague's project access. Those are
/// opposite actions on rows that otherwise look identical, so the row says
/// which it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "link")]
pub enum GrantLink {
    /// Minted by this session, and ends with it.
    ///
    /// Everything ADR 0079 already described is this: an operator's grant, and
    /// the grant admitting a join request mints. Closing the session revokes
    /// them, which is what makes a session's end a real boundary rather than a
    /// flag on a row.
    LifecycleBound,
    /// A pointer at reach the holder has by another road.
    ///
    /// The session may narrow it and may never widen it, and closing the
    /// session drops the pointer without touching what it pointed at. Built
    /// only through [`crate::SessionGrant::referencing`], which checks the
    /// narrowing against the source rather than trusting the caller.
    Referenced { source_grant_id: SessionGrantId },
}

impl GrantLink {
    /// Whether closing the session revokes this reach.
    #[must_use]
    pub fn ends_with_session(self) -> bool {
        matches!(self, Self::LifecycleBound)
    }

    /// The grant this one points at, if it points at one.
    #[must_use]
    pub fn source_grant_id(self) -> Option<SessionGrantId> {
        match self {
            Self::LifecycleBound => None,
            Self::Referenced { source_grant_id } => Some(source_grant_id),
        }
    }
}
