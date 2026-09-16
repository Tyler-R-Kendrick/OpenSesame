//! Seats, links and endings, against a real database (ADR 0079 §2, §7).
//!
//! Written as the attempt rather than the demonstration, like the sibling
//! suite: seat somebody twice, grant an observer, close a session and see what
//! survived, point at reach that closing was supposed to leave alone.

use chrono::{Duration, Utc};
use opensesame_domain::{
    Admission, GrantLink, GrantScope, JoinDecision, JoinRequest, JoinRequestId, NewSessionGrant,
    PrincipalId, SessionGrant, SessionGrantId, SessionId, SessionMembership, SessionMode,
    SessionRole, SessionVisibility, VaultId,
};
use opensesame_storage::{Db, StoredSession};

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
        display_name: "Deploy review".into(),
        visibility: SessionVisibility::Private,
        created_at: Utc::now(),
        closed_at: None,
    };
    db.create_session(&session).await.expect("session opens");
    session
}

async fn seat(
    db: &Db,
    session_id: SessionId,
    who: PrincipalId,
    by: PrincipalId,
    mode: SessionMode,
) -> SessionMembership {
    let membership = SessionMembership::new(session_id, who, mode, by, Utc::now());
    db.upsert_session_membership(ORG, &membership)
        .await
        .expect("a seat");
    membership
}

fn grant(
    session_id: SessionId,
    holder: PrincipalId,
    giver: PrincipalId,
    vault_id: VaultId,
    lifetime: Duration,
) -> SessionGrant {
    let now = Utc::now();
    SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id,
        subject_principal_id: holder,
        granted_by_principal_id: giver,
        scope: GrantScope::Collection { vault_id },
        role: SessionRole::Read,
        granted_at: now,
        expires_at: now + lifetime,
        link: GrantLink::LifecycleBound,
    })
    .expect("a valid grant")
}

// ---- SES-MODES -----------------------------------------------------------

#[tokio::test]
async fn an_observer_is_seated_without_a_single_grant_being_written() {
    // The whole coordination case. Somebody is in the room, the roster says
    // so, and nothing anywhere wrapped a key for them.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let watcher = PrincipalId::new();

    seat(&db, opened.id, watcher, operator, SessionMode::Observer).await;

    let roster = db
        .active_session_memberships(opened.id)
        .await
        .expect("a roster");
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0].principal_id, watcher);
    assert_eq!(roster[0].mode, SessionMode::Observer);
    assert_eq!(
        db.live_grant_count(opened.id, watcher, Utc::now())
            .await
            .expect("a count"),
        0,
        "seating an observer wrote a grant"
    );
    assert_eq!(
        db.active_grants_for(opened.id, watcher, Utc::now())
            .await
            .expect("no grants")
            .len(),
        0
    );
}

#[tokio::test]
async fn a_principal_holds_one_seat_and_changing_it_does_not_add_a_second() {
    // The primary key on the pair is what keeps "in the room twice, in two
    // modes" from existing. Raising is an update, never an insert.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();

    let held = seat(&db, opened.id, member, operator, SessionMode::Observer).await;
    let raised = held.raised_to_participant().expect("an active seat");
    db.upsert_session_membership(ORG, &raised)
        .await
        .expect("the seat changes");

    let roster = db
        .active_session_memberships(opened.id)
        .await
        .expect("a roster");
    assert_eq!(roster.len(), 1, "raising a member seated them twice");
    assert_eq!(roster[0].mode, SessionMode::Participant);
    assert_eq!(
        roster[0].admitted_by_principal_id, operator,
        "raising a member erased who let them in"
    );
}

#[tokio::test]
async fn lowering_is_refused_while_live_reach_remains_and_allowed_once_it_is_gone() {
    // An observer holding a wrapped key is the contradiction the mode exists
    // to rule out. The operator revokes first, because revoking is the act
    // with the consequence — ADR 0079 §3's re-keying — that lowering a mode
    // does not perform.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();
    let held = seat(&db, opened.id, member, operator, SessionMode::Participant).await;

    let minted = grant(
        opened.id,
        member,
        operator,
        VaultId::new(),
        Duration::hours(1),
    );
    db.insert_session_grant(ORG, &minted)
        .await
        .expect("a grant");

    let live = db
        .live_grant_count(opened.id, member, Utc::now())
        .await
        .expect("a count");
    assert_eq!(live, 1);
    assert!(
        held.clone().lowered_to_observer(live).is_err(),
        "somebody was lowered to observer while still holding a key"
    );

    db.revoke_session_grant(minted.id, Utc::now())
        .await
        .expect("a revocation");
    let live = db
        .live_grant_count(opened.id, member, Utc::now())
        .await
        .expect("a count");
    assert_eq!(live, 0);
    assert!(held.lowered_to_observer(live).is_ok());
}

#[tokio::test]
async fn a_seat_that_ended_is_off_the_roster_and_still_on_the_record() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();
    let held = seat(&db, opened.id, member, operator, SessionMode::Observer).await;

    let now = Utc::now();
    db.upsert_session_membership(ORG, &held.ended(now))
        .await
        .expect("the seat ends");

    assert!(db
        .active_session_memberships(opened.id)
        .await
        .expect("a roster")
        .is_empty());
    let recorded = db
        .session_membership(opened.id, member)
        .await
        .expect("a read")
        .expect("the seat is still on the record");
    assert!(!recorded.is_active());
    assert!(recorded.ended_at.is_some());
}

// ---- SES-ADMIT -----------------------------------------------------------

#[tokio::test]
async fn a_join_request_is_admitted_as_an_observer_with_no_grant_at_all() {
    // 0019's CHECK made this row unstorable: every admission had to name a
    // grant. The seat is what admission produces now, and an observer's seat
    // is a deliberate answer rather than a null.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let stranger = PrincipalId::new();

    let asked = JoinRequest::new(
        JoinRequestId::new(),
        opened.id,
        stranger,
        Some("I am shadowing this deploy".into()),
        Utc::now(),
    )
    .expect("a valid request");
    db.insert_join_request(ORG, &asked).await.expect("recorded");

    db.decide_join_request(
        ORG,
        asked.id,
        JoinDecision::Admitted {
            admission: Admission::Observer,
        },
        operator,
        Utc::now(),
        None,
    )
    .await
    .expect("an observer admission");

    let decided = db
        .join_request(ORG, asked.id)
        .await
        .expect("a read")
        .expect("the request");
    assert_eq!(
        decided.decision,
        JoinDecision::Admitted {
            admission: Admission::Observer
        }
    );
    assert_eq!(decided.decision.granted(), None);
}

#[tokio::test]
async fn admitting_an_observer_may_not_smuggle_a_grant_alongside_it() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let stranger = PrincipalId::new();
    let asked = JoinRequest::new(JoinRequestId::new(), opened.id, stranger, None, Utc::now())
        .expect("a valid request");
    db.insert_join_request(ORG, &asked).await.expect("recorded");

    let sneaked = grant(
        opened.id,
        stranger,
        operator,
        VaultId::new(),
        Duration::hours(1),
    );
    let refused = db
        .decide_join_request(
            ORG,
            asked.id,
            JoinDecision::Admitted {
                admission: Admission::Observer,
            },
            operator,
            Utc::now(),
            Some(&sneaked),
        )
        .await;
    assert!(
        refused.is_err(),
        "an observer admission carried a wrapped key"
    );
    assert!(db
        .session_grant(ORG, sneaked.id)
        .await
        .expect("a read")
        .is_none());
}

// ---- SES-LINKS -----------------------------------------------------------

#[tokio::test]
async fn a_link_round_trips_and_a_reference_keeps_the_grant_it_points_at() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();
    let vault_id = VaultId::new();

    let source = grant(opened.id, member, operator, vault_id, Duration::days(2));
    db.insert_session_grant(ORG, &source)
        .await
        .expect("the source");

    let now = Utc::now();
    let pointer = SessionGrant::referencing(
        &source,
        NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: opened.id,
            subject_principal_id: member,
            granted_by_principal_id: operator,
            scope: GrantScope::Collection { vault_id },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + Duration::hours(1),
            link: GrantLink::Referenced {
                source_grant_id: source.id,
            },
        },
    )
    .expect("a narrowing reference");
    db.insert_session_grant(ORG, &pointer)
        .await
        .expect("the pointer");

    let read = db
        .session_grant(ORG, pointer.id)
        .await
        .expect("a read")
        .expect("the pointer");
    assert_eq!(
        read.link,
        GrantLink::Referenced {
            source_grant_id: source.id
        }
    );
    assert!(!read.ends_with_session());
    assert!(db
        .session_grant(ORG, source.id)
        .await
        .expect("a read")
        .expect("the source")
        .ends_with_session());
}

// ---- SES-END -------------------------------------------------------------

#[tokio::test]
async fn closing_revokes_what_the_session_minted_and_spares_what_it_referenced() {
    // The pair the whole link distinction exists for. Closing a meeting must
    // take back the reach the meeting handed out, and must not take back the
    // project access somebody walked in with.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();
    let vault_id = VaultId::new();
    seat(&db, opened.id, member, operator, SessionMode::Participant).await;

    let minted = grant(opened.id, member, operator, vault_id, Duration::days(2));
    db.insert_session_grant(ORG, &minted).await.expect("minted");

    // Reach the member holds by another road — a longer-lived grant in their
    // own session — which this one is only going to point at.
    let other_road = session(&db, operator).await;
    let elsewhere = grant(other_road.id, member, operator, vault_id, Duration::days(3));
    db.insert_session_grant(ORG, &elsewhere)
        .await
        .expect("the other road");
    let now = Utc::now();
    let pointer = SessionGrant::referencing(
        &elsewhere,
        NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: opened.id,
            subject_principal_id: member,
            granted_by_principal_id: operator,
            scope: GrantScope::Collection { vault_id },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + Duration::days(1),
            link: GrantLink::Referenced {
                source_grant_id: elsewhere.id,
            },
        },
    )
    .expect("a narrowing reference");
    db.insert_session_grant(ORG, &pointer)
        .await
        .expect("the pointer");

    assert!(db
        .close_session(ORG, opened.id, Utc::now())
        .await
        .expect("it closes"));

    let minted = db
        .session_grant(ORG, minted.id)
        .await
        .expect("a read")
        .expect("the grant");
    assert!(
        minted.revoked_at.is_some(),
        "closing left the reach the session minted alive"
    );
    let pointer = db
        .session_grant(ORG, pointer.id)
        .await
        .expect("a read")
        .expect("the pointer");
    assert!(
        pointer.revoked_at.is_none(),
        "closing a session revoked reach it never granted"
    );
    assert!(
        db.session_grant(ORG, elsewhere.id)
            .await
            .expect("a read")
            .expect("the other road")
            .revoked_at
            .is_none(),
        "closing a session revoked the grant it was pointing at"
    );
}

#[tokio::test]
async fn closing_empties_the_room_and_is_idempotent() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    seat(
        &db,
        opened.id,
        PrincipalId::new(),
        operator,
        SessionMode::Observer,
    )
    .await;
    seat(
        &db,
        opened.id,
        PrincipalId::new(),
        operator,
        SessionMode::Participant,
    )
    .await;

    let first = Utc::now();
    assert!(db
        .close_session(ORG, opened.id, first)
        .await
        .expect("it closes"));
    assert!(
        !db.close_session(ORG, opened.id, first + Duration::hours(1))
            .await
            .expect("a second close"),
        "a second close reported closing it again"
    );

    let shut = db
        .session(ORG, opened.id)
        .await
        .expect("a read")
        .expect("the session");
    assert_eq!(
        shut.closed_at.map(|at| at.timestamp()),
        Some(first.timestamp()),
        "a second close moved the closing time"
    );
    assert!(
        db.active_session_memberships(opened.id)
            .await
            .expect("a roster")
            .is_empty(),
        "the room still has people in it after closing"
    );
}

#[tokio::test]
async fn closing_another_organizations_session_does_nothing() {
    // The organization is in the predicate rather than checked afterwards, so
    // naming a session by id from outside its organization closes nothing.
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let member = PrincipalId::new();
    seat(&db, opened.id, member, operator, SessionMode::Participant).await;
    let minted = grant(
        opened.id,
        member,
        operator,
        VaultId::new(),
        Duration::hours(2),
    );
    db.insert_session_grant(ORG, &minted).await.expect("minted");

    assert!(!db
        .close_session("org:two", opened.id, Utc::now())
        .await
        .expect("a close attempt"));

    assert!(db
        .session(ORG, opened.id)
        .await
        .expect("a read")
        .expect("the session")
        .closed_at
        .is_none());
    assert!(db
        .session_grant(ORG, minted.id)
        .await
        .expect("a read")
        .expect("the grant")
        .revoked_at
        .is_none());
    assert_eq!(
        db.active_session_memberships(opened.id)
            .await
            .expect("a roster")
            .len(),
        1
    );
}
