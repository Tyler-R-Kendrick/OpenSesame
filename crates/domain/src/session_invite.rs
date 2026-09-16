//! Share links: an offer of reach, standing until somebody takes it or it
//! lapses (ADR 0079 §7).
//!
//! Split out of [`crate::shared_session`] rather than living beside the grant
//! rules, because it is a different question. That module answers "what does
//! this reach, and for how long"; this one answers "who may come and take it",
//! which has its own clock, its own single-use rule, and its own way of being
//! wrong.
//!
//! The reach an invite mints is always [`GrantLink::LifecycleBound`]. A link
//! is the session offering something of its own, so what it hands over ends
//! when the session does; a [`GrantLink::Referenced`] pointer at reach
//! somebody already holds is not something a stranger with a URL can be given.

use crate::{
    DomainError, GrantLink, GrantScope, NewSessionGrant, PrincipalId, SessionGrant, SessionGrantId,
    SessionId, SessionInviteId, SessionRole, MIN_GRANT_LIFETIME,
};
use crate::{MAX_GRANT_LIFETIME, MIN_INVITE_LIFETIME};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Everything a new share link needs, named.
///
/// **Two clocks, and the shorter one has to be the link's.** An invite carries
/// both: how long the *offer* stands, and when the *access* it would mint
/// lapses. They are different things and people conflate them constantly — a
/// seven-day link to two hours of access is an invite most of whose life is
/// spent being dead.
///
/// [`SessionInvite::new`] refuses that combination rather than clamping it,
/// for the same reason [`SessionGrant::new`] refuses an over-long lifetime: an
/// operator who was told what they asked for believes something true. And it
/// refuses with margin — a link must close at least [`MIN_GRANT_LIFETIME`]
/// before the access does, so accepting inside the window always yields a
/// grant worth having rather than one that lapses while the page loads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewSessionInvite {
    pub id: SessionInviteId,
    pub session_id: SessionId,
    /// The operator making the offer. Becomes the grant's giver on acceptance.
    pub invited_by_principal_id: PrincipalId,
    pub scope: GrantScope,
    pub role: SessionRole,
    pub created_at: DateTime<Utc>,
    /// When the offer stops standing.
    pub link_expires_at: DateTime<Utc>,
    /// When the access this would mint lapses. Absolute, not a duration from
    /// acceptance: the operator is saying "until Friday", not "eight hours
    /// from whenever you get round to it".
    pub grant_expires_at: DateTime<Utc>,
}

/// A share link, as held.
///
/// Single use as well as timed. The clock is for the link nobody opened; once
/// [`SessionInvite::accept`] has spent it, presenting it again is refused
/// whatever the clock says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInvite {
    pub id: SessionInviteId,
    pub session_id: SessionId,
    pub invited_by_principal_id: PrincipalId,
    pub scope: GrantScope,
    pub role: SessionRole,
    pub created_at: DateTime<Utc>,
    pub link_expires_at: DateTime<Utc>,
    pub grant_expires_at: DateTime<Utc>,
    /// Set when somebody spent it. Single use, so this closes the invite.
    pub accepted_at: Option<DateTime<Utc>>,
    /// Set when the operator withdrew the offer before anybody took it.
    pub revoked_at: Option<DateTime<Utc>>,
}

impl SessionInvite {
    /// Mint an offer, refusing every shape that cannot be honoured.
    ///
    /// # Errors
    ///
    /// - [`DomainError::SessionGrantScopeEmpty`] for a row scope naming no rows.
    /// - [`DomainError::SessionGrantLifetime`] when the access it would mint is
    ///   outside the grant bounds — checked here rather than deferred to
    ///   acceptance, so an invite that could never mint anything is never sent.
    /// - [`DomainError::SessionInviteLifetime`] when the link's own life is
    ///   below [`MIN_INVITE_LIFETIME`].
    /// - [`DomainError::SessionInviteOutlivesGrant`] when the link would still
    ///   be open too close to the access lapsing.
    pub fn new(spec: NewSessionInvite) -> Result<Self, DomainError> {
        let NewSessionInvite {
            id,
            session_id,
            invited_by_principal_id,
            scope,
            role,
            created_at,
            link_expires_at,
            grant_expires_at,
        } = spec;
        scope.assert_non_empty()?;

        // The access is checked against the grant's own bounds now, not at
        // acceptance. An invite whose grant would be refused is an invite that
        // wastes somebody's time twice: once sending it, once explaining it.
        let access = grant_expires_at - created_at;
        if access < MIN_GRANT_LIFETIME {
            return Err(DomainError::SessionGrantLifetime(format!(
                "access ends {} seconds after the invite is made; the minimum is {}",
                access.num_seconds(),
                MIN_GRANT_LIFETIME.num_seconds(),
            )));
        }
        if access > MAX_GRANT_LIFETIME {
            return Err(DomainError::SessionGrantLifetime(format!(
                "access would run {} days; the ceiling is {}",
                access.num_days(),
                MAX_GRANT_LIFETIME.num_days(),
            )));
        }

        let link = link_expires_at - created_at;
        if link < MIN_INVITE_LIFETIME {
            return Err(DomainError::SessionInviteLifetime(format!(
                "the link would stand for {} seconds; the minimum is {}",
                link.num_seconds(),
                MIN_INVITE_LIFETIME.num_seconds(),
            )));
        }

        // The rule the picker draws. With margin, so a link accepted on its
        // last second still mints a grant with time left to use.
        let latest_useful = grant_expires_at - MIN_GRANT_LIFETIME;
        if link_expires_at > latest_useful {
            return Err(DomainError::SessionInviteOutlivesGrant(format!(
                "the link would stand until {link_expires_at}, but the access it \
                 carries needs it closed by {latest_useful}",
            )));
        }

        Ok(Self {
            id,
            session_id,
            invited_by_principal_id,
            scope,
            role,
            created_at,
            link_expires_at,
            grant_expires_at,
            accepted_at: None,
            revoked_at: None,
        })
    }

    /// Whether this offer can still be taken, right now.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionInviteClosed`] when it was spent, withdrawn, or
    /// has lapsed.
    pub fn assert_open(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.accepted_at.is_some() {
            return Err(DomainError::SessionInviteClosed("already accepted".into()));
        }
        if self.revoked_at.is_some() {
            return Err(DomainError::SessionInviteClosed("withdrawn".into()));
        }
        if now < self.created_at || now >= self.link_expires_at {
            return Err(DomainError::SessionInviteClosed("lapsed".into()));
        }
        Ok(())
    }

    /// Spend the offer, producing the grant it promised.
    ///
    /// The subject is a parameter, never a field on the invite: an offer is
    /// made to whoever holds the link, and who that turns out to be is decided
    /// when they present it. Returns the spent invite alongside the grant so
    /// the two are written together — an invite marked accepted with no grant,
    /// or a grant with the invite still open, are both states the caller
    /// cannot reach from here.
    ///
    /// The grant's window runs from *now* to the invite's `grant_expires_at`.
    /// Constructing the invite guaranteed at least [`MIN_GRANT_LIFETIME`]
    /// remains at any moment the link is still open, so this cannot mint the
    /// zero-length grant `SessionGrant::new` would refuse.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionInviteClosed`] when the offer is no longer open,
    /// or any error [`SessionGrant::new`] raises.
    pub fn accept(
        self,
        grant_id: SessionGrantId,
        subject_principal_id: PrincipalId,
        now: DateTime<Utc>,
    ) -> Result<(Self, SessionGrant), DomainError> {
        self.assert_open(now)?;
        let grant = SessionGrant::new(NewSessionGrant {
            id: grant_id,
            session_id: self.session_id,
            subject_principal_id,
            granted_by_principal_id: self.invited_by_principal_id,
            scope: self.scope.clone(),
            role: self.role,
            granted_at: now,
            expires_at: self.grant_expires_at,
            // A link hands over the session's own reach, so what it hands over
            // ends with the session. See this module's header.
            link: GrantLink::LifecycleBound,
        })?;
        let spent = Self {
            accepted_at: Some(now),
            ..self
        };
        Ok((spent, grant))
    }

    /// The latest a link may stand, given when the access it carries lapses.
    ///
    /// This is what a picker greys options out against: an option past this
    /// instant is not offered, so the invite that would arrive dead cannot be
    /// composed rather than being refused after the operator has chosen it.
    #[must_use]
    pub fn latest_link_expiry(grant_expires_at: DateTime<Utc>) -> DateTime<Utc> {
        grant_expires_at - MIN_GRANT_LIFETIME
    }
}
