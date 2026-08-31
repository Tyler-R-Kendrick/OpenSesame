//! The shared-session repository (ADR 0079).
//!
//! What these test is not "does the SQL round-trip" but "can this layer be
//! used to get round the rules the domain holds". Each case is written as the
//! attempt: revoke twice, decide twice, admit without a grant, read a lapsed
//! grant, reach another vault.

use chrono::{Duration, Utc};
use opensesame_domain::{
    GrantScope, JoinDecision, JoinRequest, JoinRequestId, NewSessionGrant, PrincipalId,
    SessionGrant, SessionGrantId, SessionId, SessionRole, SessionVisibility, VaultId, VaultItemId,
};
use opensesame_storage::{Db, StoredSession};
use std::collections::BTreeSet;

const ORG: &str = "org:one";

async fn db() -> Db {
    Db::connect_sqlite("sqlite::memory:")
        .await
        .expect("migrations apply")
}

async fn session(db: &Db, operator: PrincipalId) -> StoredSession {
    let session = StoredSession {
        id: SessionId::new(),
        organization_id: ORG.into(),
        operator_principal_id: operator,
        display_name: "Incident 4471".into(),
        visibility: SessionVisibility::Private,
        created_at: Utc::now(),
        closed_at: None,
    };
    db.create_session(&session).await.expect("session opens");
    session
}

fn grant(
    session_id: SessionId,
    holder: PrincipalId,
    giver: PrincipalId,
    scope: GrantScope,
    role: SessionRole,
    lifetime: Duration,
) -> SessionGrant {
    let now = Utc::now();
    SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id,
        subject_principal_id: holder,
        granted_by_principal_id: giver,
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

#[tokio::test]
async fn a_session_round_trips_with_its_operator_and_visibility() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;

    let read = db
        .session(ORG, opened.id)
        .await
        .expect("query")
        .expect("the session exists");
    assert_eq!(read.operator_principal_id, operator);
    assert_eq!(read.visibility, SessionVisibility::Private);
    assert_eq!(read.display_name, "Incident 4471");
}

#[tokio::test]
async fn a_session_is_not_visible_from_another_organization() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    assert!(
        db.session("org:other", opened.id)
            .await
            .expect("query")
            .is_none(),
        "an id from one tenant must not resolve in another"
    );
}

#[tokio::test]
async fn a_row_scope_survives_the_round_trip_intact() {
    let db = db().await;
    let holder = PrincipalId::new();
    let opened = session(&db, PrincipalId::new()).await;
    let vault_id = VaultId::new();
    let one = VaultItemId::new();
    let two = VaultItemId::new();

    let minted = grant(
        opened.id,
        holder,
        opened.operator_principal_id,
        rows(vault_id, &[one, two]),
        SessionRole::Read,
        Duration::hours(8),
    );
    db.insert_session_grant(ORG, &minted)
        .await
        .expect("grant persists");

    let live = db
        .active_grants_for(opened.id, holder, Utc::now())
        .await
        .expect("query");
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].scope, rows(vault_id, &[one, two]));
    // And the reconstructed grant answers the fence's question the same way.
    assert!(live[0].permits(holder, vault_id, one, SessionRole::Read, Utc::now()));
    assert!(!live[0].permits(
        holder,
        vault_id,
        VaultItemId::new(),
        SessionRole::Read,
        Utc::now()
    ));
}

#[tokio::test]
async fn a_lapsed_grant_is_not_returned_as_active() {
    let db = db().await;
    let holder = PrincipalId::new();
    let opened = session(&db, PrincipalId::new()).await;
    let minted = grant(
        opened.id,
        holder,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(1),
    );
    db.insert_session_grant(ORG, &minted)
        .await
        .expect("grant persists");

    let after = minted.expires_at + Duration::seconds(1);
    let live = db
        .active_grants_for(opened.id, holder, after)
        .await
        .expect("query");
    assert!(live.is_empty(), "an expired grant is not active");
}

#[tokio::test]
async fn one_participant_never_sees_another_participants_grant() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let mine = PrincipalId::new();
    let theirs = PrincipalId::new();
    db.insert_session_grant(
        ORG,
        &grant(
            opened.id,
            theirs,
            opened.operator_principal_id,
            GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            SessionRole::Write,
            Duration::hours(4),
        ),
    )
    .await
    .expect("their grant persists");

    let live = db
        .active_grants_for(opened.id, mine, Utc::now())
        .await
        .expect("query");
    assert!(
        live.is_empty(),
        "being in the same session grants nothing by itself"
    );
}

#[tokio::test]
async fn revoking_is_idempotent_and_one_way() {
    let db = db().await;
    let holder = PrincipalId::new();
    let opened = session(&db, PrincipalId::new()).await;
    let minted = grant(
        opened.id,
        holder,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(4),
    );
    db.insert_session_grant(ORG, &minted)
        .await
        .expect("grant persists");

    let first = Utc::now();
    assert!(
        db.revoke_session_grant(minted.id, first)
            .await
            .expect("revoke"),
        "the first call withdraws it"
    );
    assert!(
        !db.revoke_session_grant(minted.id, first + Duration::hours(1))
            .await
            .expect("revoke again"),
        "a second call changes nothing, and cannot move the revocation later"
    );
    assert!(
        db.active_grants_for(opened.id, holder, Utc::now())
            .await
            .expect("query")
            .is_empty(),
        "a revoked grant is not active"
    );
}

#[tokio::test]
async fn admitting_writes_the_request_and_its_grant_together() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    let request = JoinRequest::new(
        JoinRequestId::new(),
        opened.id,
        stranger,
        Some("covering the incident tonight".into()),
        Utc::now(),
    )
    .expect("a valid request");
    db.insert_join_request(ORG, &request)
        .await
        .expect("request persists");

    let minted = grant(
        opened.id,
        stranger,
        opened.operator_principal_id,
        rows(VaultId::new(), &[VaultItemId::new()]),
        SessionRole::Read,
        Duration::hours(8),
    );
    db.decide_join_request(
        ORG,
        request.id,
        JoinDecision::Admitted {
            grant_id: minted.id,
        },
        opened.operator_principal_id,
        Utc::now(),
        Some(&minted),
    )
    .await
    .expect("admission");

    let live = db
        .active_grants_for(opened.id, stranger, Utc::now())
        .await
        .expect("query");
    assert_eq!(live.len(), 1, "admission mints exactly one grant");
    assert_eq!(live[0].id, minted.id);
}

#[tokio::test]
async fn admission_without_the_grant_it_mints_is_refused() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    let request = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
        .expect("a valid request");
    db.insert_join_request(ORG, &request)
        .await
        .expect("request persists");

    let outcome = db
        .decide_join_request(
            ORG,
            request.id,
            JoinDecision::Admitted {
                grant_id: SessionGrantId::new(),
            },
            opened.operator_principal_id,
            Utc::now(),
            None,
        )
        .await;
    assert!(
        outcome.is_err(),
        "there is no admission into the room with nothing"
    );
}

#[tokio::test]
async fn admission_carrying_somebody_elses_grant_is_refused() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    let request = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
        .expect("a valid request");
    db.insert_join_request(ORG, &request)
        .await
        .expect("request persists");

    let minted = grant(
        opened.id,
        stranger,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(1),
    );
    // The decision names one grant and the write carries another: exactly the
    // drift the pairing exists to prevent.
    let outcome = db
        .decide_join_request(
            ORG,
            request.id,
            JoinDecision::Admitted {
                grant_id: SessionGrantId::new(),
            },
            opened.operator_principal_id,
            Utc::now(),
            Some(&minted),
        )
        .await;
    assert!(outcome.is_err(), "the decision and the grant must agree");
}

#[tokio::test]
async fn a_refusal_that_carries_a_grant_is_refused() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    let request = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
        .expect("a valid request");
    db.insert_join_request(ORG, &request)
        .await
        .expect("request persists");

    let minted = grant(
        opened.id,
        stranger,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(1),
    );
    let outcome = db
        .decide_join_request(
            ORG,
            request.id,
            JoinDecision::Refused,
            opened.operator_principal_id,
            Utc::now(),
            Some(&minted),
        )
        .await;
    assert!(outcome.is_err(), "a refusal grants nothing");
}

#[tokio::test]
async fn a_decided_request_is_never_decided_again() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    let request = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
        .expect("a valid request");
    db.insert_join_request(ORG, &request)
        .await
        .expect("request persists");

    db.decide_join_request(
        ORG,
        request.id,
        JoinDecision::Refused,
        opened.operator_principal_id,
        Utc::now(),
        None,
    )
    .await
    .expect("first decision");

    // A second approval must not be able to overturn a refusal in place; the
    // audit trail is append-only, so asking again is a new request.
    let minted = grant(
        opened.id,
        stranger,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Write,
        Duration::hours(8),
    );
    let outcome = db
        .decide_join_request(
            ORG,
            request.id,
            JoinDecision::Admitted {
                grant_id: minted.id,
            },
            opened.operator_principal_id,
            Utc::now(),
            Some(&minted),
        )
        .await;
    assert!(outcome.is_err(), "a decided request is not re-decided");
    assert!(
        db.active_grants_for(opened.id, stranger, Utc::now())
            .await
            .expect("query")
            .is_empty(),
        "and the grant the failed decision carried must not have landed"
    );
}

#[tokio::test]
async fn a_second_pending_ask_from_the_same_principal_is_refused() {
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let stranger = PrincipalId::new();
    for expected_ok in [true, false] {
        let request = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
            .expect("a valid request");
        let outcome = db.insert_join_request(ORG, &request).await;
        assert_eq!(
            outcome.is_ok(),
            expected_ok,
            "asking twice while pending is the same ask"
        );
    }
}

#[tokio::test]
async fn the_expiry_sweep_skips_what_was_already_withdrawn() {
    // Telling somebody their access lapses in an hour when it ended yesterday
    // is worse than silence.
    let db = db().await;
    let opened = session(&db, PrincipalId::new()).await;
    let live_holder = PrincipalId::new();
    let revoked_holder = PrincipalId::new();

    let live = grant(
        opened.id,
        live_holder,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(2),
    );
    let withdrawn = grant(
        opened.id,
        revoked_holder,
        opened.operator_principal_id,
        GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        SessionRole::Read,
        Duration::hours(2),
    );
    db.insert_session_grant(ORG, &live).await.expect("live");
    db.insert_session_grant(ORG, &withdrawn)
        .await
        .expect("withdrawn");
    db.revoke_session_grant(withdrawn.id, Utc::now())
        .await
        .expect("revoke");

    let sweep = db.session_grants_expiring(ORG, 50).await.expect("sweep");
    let ids: Vec<_> = sweep.iter().map(|grant| grant.id).collect();
    assert!(ids.contains(&live.id));
    assert!(!ids.contains(&withdrawn.id));
}
