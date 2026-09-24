//! The fence, attacked (ADR 0079).

use super::*;
use chrono::Duration;
use opensesame_domain::{GrantLink, GrantScope, NewSessionGrant, SessionId};
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
        link: GrantLink::LifecycleBound,
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
    // operator and holds no seat is `None`, whatever they have asked for.
    assert!(!Reach::None.may_see_session());
    assert!(!Reach::None.is_operator());
    assert!(!Reach::None.may_hold_reach());
    assert!(!Reach::None.may_admit());
}

#[test]
fn an_operator_manages_the_session_and_a_participant_does_not() {
    assert!(Reach::Operator.is_operator());
    assert!(Reach::Operator.may_see_session());
    assert!(Reach::Operator.may_admit());
    assert!(!Reach::Participant.is_operator());
    assert!(Reach::Participant.may_see_session());
    assert!(!Reach::Participant.may_admit());
}

#[test]
fn an_observer_is_in_the_room_and_holds_nothing() {
    // The two halves of the mode. An observer is a real participant of the
    // coordination — they see the session and its roster — and they are never
    // somebody whose grants are worth consulting, so there is no arrangement
    // of their standing that reaches an item.
    assert!(Reach::Observer.may_see_session());
    assert!(
        !Reach::Observer.may_hold_reach(),
        "an observer's grants were consulted; an observer has none, and asking \
         is what would let a stray row become reach"
    );
    assert!(!Reach::Observer.is_operator());
    assert!(!Reach::Observer.may_admit());
}

#[test]
fn running_the_session_is_still_not_reading_through_it() {
    // The rule `may_hold_reach` must not quietly repeal. An operator's grants
    // are consulted like anybody else's — which means an operator who granted
    // themselves nothing reaches nothing, exactly as before.
    let now = Utc::now();
    let operator = PrincipalId::new();
    assert!(Reach::Operator.may_hold_reach());
    assert_eq!(
        authorizing_grant(
            &[],
            operator,
            VaultId::new(),
            VaultItemId::new(),
            SessionRole::Read,
            now,
        ),
        None,
        "an operator with no grant authorized a read"
    );
}

#[test]
fn an_observers_stray_grant_is_refused_before_it_is_ever_consulted() {
    // Belt and braces for the case the schema and the mint-time check are
    // both supposed to prevent: a live, in-scope grant naming somebody seated
    // as an observer. `may_hold_reach` denies before the grant list is even
    // looked at, so a row written by hand or restored from an older shape
    // cannot become reach.
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let item_id = VaultItemId::new();
    let stray = [grant(
        holder,
        GrantScope::Collection { vault_id },
        SessionRole::Write,
        Duration::hours(1),
        now,
    )];

    // The grant itself is perfectly good; only the standing is wrong.
    assert!(authorizing_grant(&stray, holder, vault_id, item_id, SessionRole::Read, now).is_some());
    assert!(!Reach::Observer.may_hold_reach());
}
