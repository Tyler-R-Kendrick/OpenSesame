//! Atomic admission and grant writes cannot outlive session closure.
use chrono::{Duration, Utc};
use opensesame_domain::{
    GrantLink, GrantScope, JoinDecision, JoinRequest, JoinRequestId, NewSessionGrant, PrincipalId,
    SessionGrant, SessionGrantId, SessionId, SessionMembership, SessionMode, SessionRole,
    SessionVisibility, VaultId,
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

#[tokio::test]
async fn closure_refuses_admissions_and_cannot_reactivate_seats() {
    let db = db().await;
    let operator = PrincipalId::new();
    for mode in [SessionMode::Observer, SessionMode::Participant] {
        let opened = session(&db, operator).await;
        let asker = PrincipalId::new();
        let request =
            JoinRequest::new(JoinRequestId::new(), opened.id, asker, None, Utc::now()).unwrap();
        db.insert_join_request(ORG, &request).await.unwrap();
        let minted = grant(
            opened.id,
            asker,
            operator,
            VaultId::new(),
            Duration::hours(1),
        );
        let decision = match mode {
            SessionMode::Observer => JoinDecision::Admitted {
                admission: opensesame_domain::Admission::Observer,
            },
            SessionMode::Participant => JoinDecision::Admitted {
                admission: opensesame_domain::Admission::Participant {
                    grant_id: minted.id,
                },
            },
        };
        db.close_session(ORG, opened.id, Utc::now()).await.unwrap();
        let result = db
            .decide_join_request(
                ORG,
                request.id,
                decision,
                operator,
                Utc::now(),
                (mode == SessionMode::Participant).then_some(&minted),
            )
            .await;
        assert!(result
            .unwrap_err()
            .is::<opensesame_storage::ClosedOrDecided>());
        assert_eq!(
            db.join_request(ORG, request.id)
                .await
                .unwrap()
                .unwrap()
                .decision,
            JoinDecision::Pending
        );
        assert!(db
            .session_membership(opened.id, asker)
            .await
            .unwrap()
            .is_none());
        assert!(db.session_grant(ORG, minted.id).await.unwrap().is_none());
        let membership = SessionMembership::new(opened.id, asker, mode, operator, Utc::now());
        assert!(db
            .upsert_session_membership(ORG, &membership)
            .await
            .is_err());
        assert!(db
            .session_membership(opened.id, asker)
            .await
            .unwrap()
            .is_none());
        assert!(db
            .decide_join_request(
                ORG,
                request.id,
                JoinDecision::Refused,
                operator,
                Utc::now(),
                None
            )
            .await
            .is_err());
    }
}

#[tokio::test]
async fn a_failed_seat_rolls_back_the_decision_and_minted_grant() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let asker = PrincipalId::new();
    let request =
        JoinRequest::new(JoinRequestId::new(), opened.id, asker, None, Utc::now()).unwrap();
    db.insert_join_request(ORG, &request).await.unwrap();
    let minted = grant(
        opened.id,
        asker,
        operator,
        VaultId::new(),
        Duration::hours(1),
    );
    sqlx::query("CREATE TRIGGER reject_seat BEFORE INSERT ON session_memberships BEGIN SELECT RAISE(ABORT, 'seat refused'); END").execute(db.pool()).await.unwrap();
    let decision = JoinDecision::Admitted {
        admission: opensesame_domain::Admission::Participant {
            grant_id: minted.id,
        },
    };
    assert!(db
        .decide_join_request(
            ORG,
            request.id,
            decision,
            operator,
            Utc::now(),
            Some(&minted)
        )
        .await
        .is_err());
    assert_eq!(
        db.join_request(ORG, request.id)
            .await
            .unwrap()
            .unwrap()
            .decision,
        JoinDecision::Pending
    );
    assert!(db.session_grant(ORG, minted.id).await.unwrap().is_none());
    assert!(db
        .session_membership(opened.id, asker)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn overlapping_close_and_admission_leave_no_active_seat_or_grant() {
    let path = std::env::temp_dir().join(format!("session-close-{}.sqlite", SessionId::new()));
    let db = Db::connect_sqlite(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    let operator = PrincipalId::new();
    for mode in [SessionMode::Observer, SessionMode::Participant] {
        for _ in 0..8 {
            overlap_once(&db, operator, mode).await;
        }
    }
    db.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn admission_rejects_a_grant_for_another_session_or_principal() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let other = session(&db, operator).await;
    let asker = PrincipalId::new();
    let request =
        JoinRequest::new(JoinRequestId::new(), opened.id, asker, None, Utc::now()).unwrap();
    db.insert_join_request(ORG, &request).await.unwrap();
    for (session_id, subject) in [(other.id, asker), (opened.id, PrincipalId::new())] {
        let minted = grant(
            session_id,
            subject,
            operator,
            VaultId::new(),
            Duration::hours(1),
        );
        let decision = JoinDecision::Admitted {
            admission: opensesame_domain::Admission::Participant {
                grant_id: minted.id,
            },
        };
        assert!(db
            .decide_join_request(
                ORG,
                request.id,
                decision,
                operator,
                Utc::now(),
                Some(&minted)
            )
            .await
            .is_err());
        assert!(db.session_grant(ORG, minted.id).await.unwrap().is_none());
        assert!(db
            .session_membership(opened.id, asker)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            db.join_request(ORG, request.id)
                .await
                .unwrap()
                .unwrap()
                .decision,
            JoinDecision::Pending
        );
    }
}

async fn overlap_once(db: &Db, operator: PrincipalId, mode: SessionMode) {
    let opened = session(db, operator).await;
    let asker = PrincipalId::new();
    let request =
        JoinRequest::new(JoinRequestId::new(), opened.id, asker, None, Utc::now()).unwrap();
    db.insert_join_request(ORG, &request).await.unwrap();
    let minted = grant(
        opened.id,
        asker,
        operator,
        VaultId::new(),
        Duration::hours(1),
    );
    let admission = if mode == SessionMode::Observer {
        opensesame_domain::Admission::Observer
    } else {
        opensesame_domain::Admission::Participant {
            grant_id: minted.id,
        }
    };
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let closing = {
        let db = db.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            db.close_session(ORG, opened.id, Utc::now()).await
        })
    };
    barrier.wait().await;
    let result = db
        .decide_join_request(
            ORG,
            request.id,
            JoinDecision::Admitted { admission },
            operator,
            Utc::now(),
            (mode == SessionMode::Participant).then_some(&minted),
        )
        .await;
    assert!(closing.await.unwrap().unwrap());
    if let Err(error) = result {
        assert!(error.is::<opensesame_storage::ClosedOrDecided>(), "{error}");
    }
    assert!(db
        .active_session_memberships(opened.id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        db.live_grant_count(opened.id, asker, Utc::now())
            .await
            .unwrap(),
        0
    );
    if let Some(grant) = db.session_grant(ORG, minted.id).await.unwrap() {
        assert!(grant.revoked_at.is_some());
    }
}

#[tokio::test]
async fn direct_grants_cannot_be_inserted_after_session_closure() {
    let db = db().await;
    let operator = PrincipalId::new();
    let opened = session(&db, operator).await;
    let asker = PrincipalId::new();
    let minted = grant(
        opened.id,
        asker,
        operator,
        VaultId::new(),
        Duration::hours(1),
    );
    db.close_session(ORG, opened.id, Utc::now()).await.unwrap();
    assert!(db
        .insert_session_grant(ORG, &minted)
        .await
        .unwrap_err()
        .is::<opensesame_storage::SessionClosed>());
    assert!(db.session_grant(ORG, minted.id).await.unwrap().is_none());
}

#[tokio::test]
async fn overlapping_direct_grant_and_close_never_leave_live_authority() {
    let path = std::env::temp_dir().join(format!("direct-close-{}.sqlite", SessionId::new()));
    let db = Db::connect_sqlite(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    let operator = PrincipalId::new();
    for _ in 0..8 {
        let opened = session(&db, operator).await;
        let asker = PrincipalId::new();
        let minted = grant(
            opened.id,
            asker,
            operator,
            VaultId::new(),
            Duration::hours(1),
        );
        let membership = SessionMembership::new(
            opened.id,
            asker,
            SessionMode::Participant,
            operator,
            Utc::now(),
        );
        db.upsert_session_membership(ORG, &membership)
            .await
            .unwrap();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let closing = spawn_close(&db, opened.id, &barrier);
        barrier.wait().await;
        let result = db.insert_session_grant(ORG, &minted).await;
        assert!(closing.await.unwrap().unwrap());
        if let Err(error) = result {
            assert!(error.is::<opensesame_storage::SessionClosed>(), "{error}");
        }
        assert!(db
            .active_session_memberships(opened.id)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.live_grant_count(opened.id, asker, Utc::now())
                .await
                .unwrap(),
            0
        );
        if let Some(grant) = db.session_grant(ORG, minted.id).await.unwrap() {
            assert!(grant.revoked_at.is_some());
        }
    }
    db.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

fn spawn_close(
    db: &Db,
    id: SessionId,
    barrier: &std::sync::Arc<tokio::sync::Barrier>,
) -> tokio::task::JoinHandle<anyhow::Result<bool>> {
    let db = db.clone();
    let barrier = barrier.clone();
    tokio::spawn(async move {
        barrier.wait().await;
        db.close_session(ORG, id, Utc::now()).await
    })
}
