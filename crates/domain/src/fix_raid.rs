//! FIX-RAID — observer metadata-only and lifecycle-bound vs referenced reach.

use chrono::{Duration, Utc};

use crate::{
    DomainError, GrantLink, GrantScope, NewSessionGrant, PrincipalId, SessionGrant, SessionGrantId,
    SessionId, SessionMembership, SessionMode, SessionRole, VaultId, VaultItemId,
};

fn collection_grant(
    session_id: SessionId,
    subject: PrincipalId,
    vault_id: VaultId,
    role: SessionRole,
    lifetime: Duration,
    now: chrono::DateTime<Utc>,
) -> SessionGrant {
    SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id,
        subject_principal_id: subject,
        granted_by_principal_id: PrincipalId::new(),
        scope: GrantScope::Collection { vault_id },
        role,
        granted_at: now,
        expires_at: now + lifetime,
        link: GrantLink::LifecycleBound,
    })
    .expect("lifecycle-bound collection grant")
}

#[test]
fn fix_raid_observer_is_metadata_only_with_no_vault_key() {
    let now = Utc::now();
    let observer = SessionMembership::new(
        SessionId::new(),
        PrincipalId::new(),
        SessionMode::Observer,
        PrincipalId::new(),
        now,
    );
    assert!(
        matches!(
            observer.assert_may_hold_grant(),
            Err(DomainError::SessionObserverHoldsNoGrant)
        ),
        "observer admission must not mint vault-key reach"
    );
    assert!(!observer.mode.may_hold_a_grant());
}

#[test]
fn fix_raid_leave_or_end_terminates_lifecycle_bound_reach() {
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let minted = collection_grant(
        SessionId::new(),
        holder,
        vault_id,
        SessionRole::Read,
        Duration::hours(1),
        now,
    );
    assert!(
        minted.ends_with_session(),
        "raid-issued reach must be lifecycle-bound"
    );
    assert!(minted.permits(holder, vault_id, VaultItemId::new(), SessionRole::Read, now));
}

#[test]
fn fix_raid_referenced_independent_grant_survives_end() {
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let source = collection_grant(
        SessionId::new(),
        holder,
        vault_id,
        SessionRole::Read,
        Duration::days(2),
        now,
    );
    let pointer = SessionGrant::referencing(
        &source,
        NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: holder,
            granted_by_principal_id: PrincipalId::new(),
            scope: GrantScope::Collection { vault_id },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + Duration::hours(1),
            link: GrantLink::Referenced {
                source_grant_id: source.id,
            },
        },
    )
    .expect("narrowing reference");

    assert!(
        !pointer.ends_with_session(),
        "referenced independent reach must survive raid end"
    );
    assert!(!GrantLink::Referenced {
        source_grant_id: source.id
    }
    .ends_with_session());
}
