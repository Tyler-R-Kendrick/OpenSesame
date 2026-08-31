//! Shared sessions: who is in one, what each participant may reach, and for
//! how long (ADR 0079).
//!
//! A session is a live collaboration several principals are in at once. Being
//! *in* one grants nothing: presence and permission are separate, and every
//! read a participant makes is authorized against a [`SessionGrant`] naming
//! exactly what they may reach.
//!
//! This module is pure. It holds no clock of its own, does no I/O, and knows
//! nothing about the transport — its whole job is the rules that must hold
//! wherever a grant is created, narrowed, or checked:
//!
//! 1. **Every grant expires.** There is no standing session grant, because
//!    withdrawing one does not un-read what was already opened: the key a
//!    participant was handed keeps working on ciphertext they copied until the
//!    item is re-keyed (ADR 0079 §3). A lifetime is therefore mandatory and
//!    capped at [`MAX_GRANT_LIFETIME`].
//! 2. **Expiry is enforced here, not only announced.** [`SessionGrant::assert_active`]
//!    compares against the caller's clock reading on every check. The
//!    `lifecycle.*` feed (ADR 0074) announces the deadline to subscribers; it
//!    is never what stops access, so a scanner that misses a tick cannot
//!    extend anybody's reach.
//! 3. **Scope narrows, never widens.** [`GrantScope::narrows_to`] is the
//!    subset test every re-grant and delegation must pass.
//! 4. **Admission is a grant.** A join request cannot be accepted into "in the
//!    room with nothing": [`JoinDecision::Admitted`] carries the grant id that
//!    admitting minted, so the two cannot drift apart.

use crate::{
    DomainError, JoinRequestId, PrincipalId, SessionGrantId, SessionId, SessionInviteId, VaultId,
    VaultItemId,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The longest a session grant may run.
///
/// Seven days is a handover, not a standing arrangement. The cap exists
/// because revocation is re-keying rather than a switch: the shorter a grant
/// lives, the smaller the window in which a copied ciphertext stays readable
/// after the operator has changed their mind.
pub const MAX_GRANT_LIFETIME: Duration = Duration::days(7);

/// The shortest a grant may run. Below this a grant is over before the
/// recipient can act on it, which is a mistake rather than a policy.
pub const MIN_GRANT_LIFETIME: Duration = Duration::minutes(1);

/// How much of a stranger's "why I need in" is kept.
///
/// The note is untrusted text from somebody with no standing in the session,
/// shown to an operator. Bounded so it cannot be used to flood a reviewer's
/// screen or a stored row.
pub const MAX_JOIN_NOTE_CHARS: usize = 280;

/// What a participant may do with what they can reach.
///
/// Deliberately two rungs. Anything finer (share-onward, administer) would be
/// a way to hand out authority the granting operator still owns, and ADR 0079
/// keeps that with the operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    Read,
    Write,
}

impl SessionRole {
    /// Whether this role covers `wanted`. Writing implies reading; nothing
    /// implies writing.
    #[must_use]
    pub fn covers(self, wanted: Self) -> bool {
        self >= wanted
    }
}

/// What a grant reaches, at the grain the key hierarchy already has.
///
/// A whole collection wraps the collection key; chosen rows wrap each item's
/// own key (ADR 0079 §3). The two are not interchangeable and `Rows` is never
/// silently promoted to `Collection`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum GrantScope {
    /// Every item in the vault, including ones added later.
    Collection { vault_id: VaultId },
    /// Exactly these items, and nothing that arrives afterwards.
    Rows {
        vault_id: VaultId,
        items: BTreeSet<VaultItemId>,
    },
}

impl GrantScope {
    /// The vault this scope is anchored to. A grant never spans two.
    #[must_use]
    pub fn vault_id(&self) -> VaultId {
        match self {
            Self::Collection { vault_id } | Self::Rows { vault_id, .. } => *vault_id,
        }
    }

    /// Whether this scope reaches one item.
    ///
    /// Deny is the default in every branch: a different vault is refused
    /// before the item is even considered, and an item absent from a `Rows`
    /// set is refused rather than treated as unspecified.
    #[must_use]
    pub fn admits(&self, vault_id: VaultId, item_id: VaultItemId) -> bool {
        if self.vault_id() != vault_id {
            return false;
        }
        match self {
            Self::Collection { .. } => true,
            Self::Rows { items, .. } => items.contains(&item_id),
        }
    }

    /// Whether `self` reaches no further than `ceiling`.
    ///
    /// The test every re-grant must pass. `Collection` narrows only to
    /// `Collection` on the same vault — a whole-vault grant cannot be carved
    /// out of a handful of rows, which is the mistake this catches.
    #[must_use]
    pub fn narrows_to(&self, ceiling: &Self) -> bool {
        if self.vault_id() != ceiling.vault_id() {
            return false;
        }
        match (self, ceiling) {
            (_, Self::Collection { .. }) => true,
            (Self::Collection { .. }, Self::Rows { .. }) => false,
            (Self::Rows { items, .. }, Self::Rows { items: allowed, .. }) => {
                items.is_subset(allowed)
            }
        }
    }

    /// How many rows this names, for a readout. `Collection` has no count —
    /// that is the point of it.
    #[must_use]
    pub fn row_count(&self) -> Option<usize> {
        match self {
            Self::Collection { .. } => None,
            Self::Rows { items, .. } => Some(items.len()),
        }
    }

    ///
    /// # Errors
    ///
    /// Returns [`DomainError::SessionGrantScopeEmpty`] when a row scope names
    /// no rows — a grant to nothing is a mistake, not a null grant.
    pub fn assert_non_empty(&self) -> Result<(), DomainError> {
        if self.row_count() == Some(0) {
            return Err(DomainError::SessionGrantScopeEmpty);
        }
        Ok(())
    }
}

/// One participant's reach into one session, for a bounded time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionGrant {
    pub id: SessionGrantId,
    pub session_id: SessionId,
    /// Who holds it.
    pub subject_principal_id: PrincipalId,
    /// Who gave it. An operator can always be named for any reach.
    pub granted_by_principal_id: PrincipalId,
    pub scope: GrantScope,
    pub role: SessionRole,
    pub granted_at: DateTime<Utc>,
    /// Never optional. See [`MAX_GRANT_LIFETIME`].
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// Everything a new grant needs, named.
///
/// A struct rather than eight positional arguments, and not only for the
/// arity: `subject_principal_id` and `granted_by_principal_id` are the same
/// type and sit next to each other, so positionally they are one transposition
/// away from a grant that hands the operator's reach to the wrong party.
/// Naming them makes that swap something you have to write on purpose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewSessionGrant {
    pub id: SessionGrantId,
    pub session_id: SessionId,
    /// Who will hold the grant.
    pub subject_principal_id: PrincipalId,
    /// Who is giving it.
    pub granted_by_principal_id: PrincipalId,
    pub scope: GrantScope,
    pub role: SessionRole,
    pub granted_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl SessionGrant {
    /// Mint a grant, refusing a lifetime outside the bounds.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionGrantLifetime`] when `expires_at` is not between
    /// [`MIN_GRANT_LIFETIME`] and [`MAX_GRANT_LIFETIME`] after `granted_at`,
    /// and [`DomainError::SessionGrantScopeEmpty`] for a row scope naming no
    /// rows. An over-long lifetime is refused rather than clamped: silently
    /// shortening it would leave the operator believing something the system
    /// did not do.
    pub fn new(spec: NewSessionGrant) -> Result<Self, DomainError> {
        let NewSessionGrant {
            id,
            session_id,
            subject_principal_id,
            granted_by_principal_id,
            scope,
            role,
            granted_at,
            expires_at,
        } = spec;
        scope.assert_non_empty()?;
        let lifetime = expires_at - granted_at;
        if lifetime < MIN_GRANT_LIFETIME {
            return Err(DomainError::SessionGrantLifetime(format!(
                "{} seconds is shorter than the {} second minimum",
                lifetime.num_seconds(),
                MIN_GRANT_LIFETIME.num_seconds()
            )));
        }
        if lifetime > MAX_GRANT_LIFETIME {
            return Err(DomainError::SessionGrantLifetime(format!(
                "{} days is longer than the {} day maximum",
                lifetime.num_days(),
                MAX_GRANT_LIFETIME.num_days()
            )));
        }
        Ok(Self {
            id,
            session_id,
            subject_principal_id,
            granted_by_principal_id,
            scope,
            role,
            granted_at,
            expires_at,
            revoked_at: None,
        })
    }

    /// The enforcement point. Every authorization check calls this with its
    /// own clock reading — the lifecycle feed announces expiry, it never
    /// performs it.
    ///
    /// # Errors
    ///
    /// [`DomainError::GrantRevoked`] or [`DomainError::GrantTimeWindow`].
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.revoked_at.is_some() {
            return Err(DomainError::GrantRevoked);
        }
        if now < self.granted_at || now >= self.expires_at {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    /// Whether this grant lets `subject` do `wanted` to one item, right now.
    ///
    /// The single question the authorization fence asks. It is deliberately
    /// one function: a caller that checked the scope but forgot the clock, or
    /// the clock but forgot the subject, is the bug this shape prevents.
    #[must_use]
    pub fn permits(
        &self,
        subject_principal_id: PrincipalId,
        vault_id: VaultId,
        item_id: VaultItemId,
        wanted: SessionRole,
        now: DateTime<Utc>,
    ) -> bool {
        self.subject_principal_id == subject_principal_id
            && self.assert_active(now).is_ok()
            && self.role.covers(wanted)
            && self.scope.admits(vault_id, item_id)
    }

    /// Whether this grant reaches no further than `ceiling`, in scope, role
    /// and time. Used when one grant is derived from another.
    #[must_use]
    pub fn narrows_to(&self, ceiling: &Self) -> bool {
        self.scope.narrows_to(&ceiling.scope)
            && ceiling.role.covers(self.role)
            && self.expires_at <= ceiling.expires_at
    }
}

/// Whether a session accepts requests from people who were never invited.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionVisibility {
    /// Reachable only by invitation. Nothing about it is discoverable.
    Private,
    /// Discoverable and open to join requests. The discovery record carries a
    /// name and nothing else — never the roster, the items, or their count.
    Public,
}

/// What became of a request to join.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum JoinDecision {
    Pending,
    /// Admitting mints a grant, and the decision carries its id.
    ///
    /// There is no shape here for "admitted with nothing": an operator who
    /// wants somebody present but empty-handed is describing a grant of zero
    /// rows, which [`GrantScope::assert_non_empty`] already refuses.
    Admitted {
        grant_id: SessionGrantId,
    },
    Refused,
}

/// Somebody with no standing asking to be let in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinRequest {
    pub id: JoinRequestId,
    pub session_id: SessionId,
    pub requester_principal_id: PrincipalId,
    /// The requester's own words, bounded. Untrusted text: whatever renders
    /// this escapes it.
    pub note: Option<String>,
    pub requested_at: DateTime<Utc>,
    pub decision: JoinDecision,
    pub decided_at: Option<DateTime<Utc>>,
    pub decided_by_principal_id: Option<PrincipalId>,
}

impl JoinRequest {
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionJoinNoteTooLong`] when the note exceeds
    /// [`MAX_JOIN_NOTE_CHARS`]. Counted in characters rather than bytes so the
    /// bound means the same thing in every script.
    pub fn new(
        id: JoinRequestId,
        session_id: SessionId,
        requester_principal_id: PrincipalId,
        note: Option<String>,
        requested_at: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        if let Some(text) = note.as_ref() {
            let length = text.chars().count();
            if length > MAX_JOIN_NOTE_CHARS {
                return Err(DomainError::SessionJoinNoteTooLong(length));
            }
        }
        Ok(Self {
            id,
            session_id,
            requester_principal_id,
            note,
            requested_at,
            decision: JoinDecision::Pending,
            decided_at: None,
            decided_by_principal_id: None,
        })
    }

    /// Whether this request is still awaiting a decision. A decided request is
    /// never re-decided — the caller mints a new one instead, so an audit
    /// trail cannot be rewritten by a second approval.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        matches!(self.decision, JoinDecision::Pending)
    }
}

/// The default lifetime of a share link, when the operator does not choose.
///
/// A day. Long enough to reach somebody in another timezone without a second
/// attempt; short enough that a link forwarded into a group chat is dead by
/// the next morning. Deployments override it — this is the fallback, not a
/// policy.
pub const DEFAULT_INVITE_LIFETIME: Duration = Duration::hours(24);

/// The shortest a share link may stand.
///
/// Below this the recipient cannot realistically open it, which makes the
/// invite a mistake rather than a tight policy.
pub const MIN_INVITE_LIFETIME: Duration = Duration::minutes(1);

/// An offer of reach, standing until somebody takes it or it lapses.
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
///
/// Single use as well as timed. The clock is for the link nobody opened; once
/// [`SessionInvite::accept`] has spent it, presenting it again is refused
/// whatever the clock says.
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
