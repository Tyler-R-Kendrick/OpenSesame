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
//! 4. **Admission is a named seat.** A join request cannot be accepted into an
//!    unstated standing: [`JoinDecision::Admitted`] carries an [`Admission`],
//!    which is either the grant admitting minted or an explicit observer seat
//!    (see [`crate::session_coordination`]). There is no shape for "admitted,
//!    and we will work out what that means later".
//! 5. **Reach says whether it ends with the session.** Every grant carries a
//!    [`GrantLink`]: minted by the session and revoked when it closes, or a
//!    narrowed pointer at reach the holder already had, which closing must
//!    leave alone.

use crate::{
    Admission, DomainError, GrantLink, JoinRequestId, PrincipalId, SessionGrantId, SessionId,
    VaultId, VaultItemId,
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
    /// Whether closing the session takes this reach back. See [`GrantLink`].
    pub link: GrantLink,
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
    /// [`GrantLink::LifecycleBound`] for reach the session is minting.
    /// [`GrantLink::Referenced`] is refused here and built only by
    /// [`SessionGrant::referencing`], which has the source to check against.
    pub link: GrantLink,
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
    ///
    /// [`DomainError::SessionGrantLinkUnchecked`] when the spec claims
    /// [`GrantLink::Referenced`]. A pointer at somebody else's reach is only
    /// safe once it has been compared with what it points at, and this
    /// constructor has not been handed that — so it refuses rather than
    /// recording an unverified claim. [`SessionGrant::referencing`] is the
    /// road that does the comparison.
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
            link,
        } = spec;
        if let GrantLink::Referenced { source_grant_id } = link {
            return Err(DomainError::SessionGrantLinkUnchecked(format!(
                "a reference to {source_grant_id} must be built with \
                 SessionGrant::referencing, which checks it narrows"
            )));
        }
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
            link,
            revoked_at: None,
        })
    }

    /// Point this session at reach the subject already holds elsewhere.
    ///
    /// The other half of [`GrantLink`]. A referenced grant is how a session
    /// says "this person can already see the deployment vault, and that is
    /// what they are using here" without the session having minted anything —
    /// so closing the session takes nothing away.
    ///
    /// Three things are checked against `source` rather than trusted from the
    /// spec, because a reference the caller described is a reference the
    /// caller could have described wrongly:
    ///
    /// 1. **It points where it says it does.** The spec's `source_grant_id`
    ///    must be `source`'s own id.
    /// 2. **It is the same person's reach.** A reference naming a different
    ///    subject is not a narrowing, it is a transfer: it would let a session
    ///    hand one member's vault access to another under the cover of
    ///    "referencing an existing grant".
    /// 3. **It narrows.** Scope, role and expiry all go through
    ///    [`SessionGrant::narrows_to`], so the pointer cannot reach further,
    ///    write where the source reads, or outlive it.
    ///
    /// The source must also be live at `granted_at`: referencing a revoked or
    /// lapsed grant would resurrect it.
    ///
    /// # Errors
    ///
    /// [`DomainError::SessionGrantLinkUnchecked`] for a spec that is not a
    /// reference, points elsewhere, or names another subject;
    /// [`DomainError::GrantRevoked`] or [`DomainError::GrantTimeWindow`] for a
    /// source that is not live; [`DomainError::SessionGrantWiden`] when the
    /// pointer reaches further than what it points at; and any error
    /// [`SessionGrant::new`] raises about the lifetime or the scope.
    pub fn referencing(source: &Self, spec: NewSessionGrant) -> Result<Self, DomainError> {
        let GrantLink::Referenced { source_grant_id } = spec.link else {
            return Err(DomainError::SessionGrantLinkUnchecked(
                "referencing built a grant that does not claim to be a reference".into(),
            ));
        };
        if source_grant_id != source.id {
            return Err(DomainError::SessionGrantLinkUnchecked(format!(
                "the reference names {source_grant_id} but was checked against {}",
                source.id
            )));
        }
        if spec.subject_principal_id != source.subject_principal_id {
            return Err(DomainError::SessionGrantLinkUnchecked(
                "a reference to somebody else's grant is a transfer, not a narrowing".into(),
            ));
        }
        source.assert_active(spec.granted_at)?;

        // Built as a lifecycle-bound grant first so everything `new` enforces
        // — the lifetime window, the non-empty row scope — is enforced here
        // too, and then relabelled. Re-implementing those checks for the
        // reference road is how the two roads drift apart.
        let bound = Self::new(NewSessionGrant {
            link: GrantLink::LifecycleBound,
            ..spec
        })?;
        if !bound.narrows_to(source) {
            return Err(DomainError::SessionGrantWiden(format!(
                "the reference reaches further than grant {}",
                source.id
            )));
        }
        Ok(Self {
            link: GrantLink::Referenced { source_grant_id },
            ..bound
        })
    }

    /// Whether closing the session revokes this reach.
    #[must_use]
    pub fn ends_with_session(&self) -> bool {
        self.link.ends_with_session()
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
    /// Admitting seats somebody, and the decision carries which seat.
    ///
    /// There is still no shape here for an unstated admission. What changed
    /// with coordination sessions is that "empty-handed" became a seat an
    /// operator can deliberately choose — [`Admission::Observer`] — rather
    /// than a grant of zero rows, which [`GrantScope::assert_non_empty`] still
    /// refuses. The operator says which; nothing infers it from a null.
    Admitted {
        admission: Admission,
    },
    Refused,
}

impl JoinDecision {
    /// The grant this decision minted, if it minted one.
    #[must_use]
    pub fn granted(self) -> Option<SessionGrantId> {
        match self {
            Self::Admitted { admission } => admission.grant_id(),
            Self::Pending | Self::Refused => None,
        }
    }
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
/// invite a mistake rather than a tight policy. The link type itself lives in
/// [`crate::session_invite`].
pub const MIN_INVITE_LIFETIME: Duration = Duration::minutes(1);
