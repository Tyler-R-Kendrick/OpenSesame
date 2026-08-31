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
use opensesame_domain::{
    PrincipalId, SessionGrant, SessionGrantId, SessionRole, VaultId, VaultItemId,
};
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
mod tests {
    use super::*;
    use chrono::Duration;
    use opensesame_domain::{GrantScope, NewSessionGrant, SessionId};
    use std::collections::BTreeSet;

    fn grant(
        holder: PrincipalId,
        scope: GrantScope,
        role: SessionRole,
        lifetime: Duration,
        now: DateTime<Utc>,
    ) -> SessionGrant {
        SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: holder,
            granted_by_principal_id: PrincipalId::new(),
            scope,
            role,
            granted_at: now,
            expires_at: now + lifetime,
        })
        .expect("a valid grant")
    }

    fn rows(vault_id: VaultId, items: &[VaultItemId]) -> GrantScope {
        GrantScope::Rows {
            vault_id,
            items: items.iter().copied().collect::<BTreeSet<_>>(),
        }
    }

    #[test]
    fn no_grants_is_a_denial() {
        let now = Utc::now();
        assert_eq!(
            authorizing_grant(
                &[],
                PrincipalId::new(),
                VaultId::new(),
                VaultItemId::new(),
                SessionRole::Read,
                now,
            ),
            None
        );
    }

    #[test]
    fn a_collection_grant_reaches_any_row_in_that_vault_only() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let held = grant(
            holder,
            GrantScope::Collection { vault_id },
            SessionRole::Read,
            Duration::hours(1),
            now,
        );
        let grants = [held.clone()];

        assert_eq!(
            authorizing_grant(
                &grants,
                holder,
                vault_id,
                VaultItemId::new(),
                SessionRole::Read,
                now
            ),
            Some(held.id)
        );
        // A different vault is a different vault, whatever the item id says.
        assert_eq!(
            authorizing_grant(
                &grants,
                holder,
                VaultId::new(),
                VaultItemId::new(),
                SessionRole::Read,
                now
            ),
            None
        );
    }

    #[test]
    fn a_row_grant_reaches_its_rows_and_stops() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let mine = VaultItemId::new();
        let theirs = VaultItemId::new();
        let held = grant(
            holder,
            rows(vault_id, &[mine]),
            SessionRole::Read,
            Duration::hours(1),
            now,
        );
        let grants = [held.clone()];

        assert_eq!(
            authorizing_grant(&grants, holder, vault_id, mine, SessionRole::Read, now),
            Some(held.id)
        );
        assert_eq!(
            authorizing_grant(&grants, holder, vault_id, theirs, SessionRole::Read, now),
            None,
            "a row grant reached a row it was never given"
        );
    }

    #[test]
    fn somebody_elses_grant_never_authorizes_this_caller() {
        let now = Utc::now();
        let vault_id = VaultId::new();
        let item_id = VaultItemId::new();
        // The grant is live, in scope, and for the right role — and belongs to
        // somebody else. This is the case a fence that only checked scope
        // would get wrong.
        let grants = [grant(
            PrincipalId::new(),
            GrantScope::Collection { vault_id },
            SessionRole::Write,
            Duration::hours(1),
            now,
        )];
        assert_eq!(
            authorizing_grant(
                &grants,
                PrincipalId::new(),
                vault_id,
                item_id,
                SessionRole::Read,
                now
            ),
            None
        );
    }

    #[test]
    fn a_read_grant_does_not_authorize_a_write() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let item_id = VaultItemId::new();
        let grants = [grant(
            holder,
            GrantScope::Collection { vault_id },
            SessionRole::Read,
            Duration::hours(1),
            now,
        )];
        assert!(
            authorizing_grant(&grants, holder, vault_id, item_id, SessionRole::Read, now).is_some()
        );
        assert_eq!(
            authorizing_grant(&grants, holder, vault_id, item_id, SessionRole::Write, now),
            None,
            "a read grant authorized a write"
        );
    }

    #[test]
    fn a_lapsed_grant_authorizes_nothing_even_though_it_is_still_in_the_list() {
        // The store already filters on expiry. This is the second check: if a
        // stale row ever reaches the fence — a slow query, a clock skew, a
        // cached list — the answer is still no.
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let item_id = VaultItemId::new();
        let grants = [grant(
            holder,
            GrantScope::Collection { vault_id },
            SessionRole::Read,
            Duration::minutes(1),
            now,
        )];
        assert!(
            authorizing_grant(&grants, holder, vault_id, item_id, SessionRole::Read, now).is_some()
        );
        assert_eq!(
            authorizing_grant(
                &grants,
                holder,
                vault_id,
                item_id,
                SessionRole::Read,
                now + Duration::minutes(2),
            ),
            None,
            "an expired grant still authorized a read"
        );
    }

    #[test]
    fn the_widest_matching_grant_is_not_required_to_be_the_only_one() {
        // Two grants, one narrow and one wide, both live. The fence answers
        // with whichever authorizes — it is not a policy about which grant
        // "should" apply, and it must not deny because a narrower one exists.
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let named = VaultItemId::new();
        let other = VaultItemId::new();
        let narrow = grant(
            holder,
            rows(vault_id, &[named]),
            SessionRole::Read,
            Duration::hours(1),
            now,
        );
        let wide = grant(
            holder,
            GrantScope::Collection { vault_id },
            SessionRole::Read,
            Duration::hours(1),
            now,
        );
        let grants = [narrow, wide.clone()];
        assert_eq!(
            authorizing_grant(&grants, holder, vault_id, other, SessionRole::Read, now),
            Some(wide.id)
        );
    }

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
