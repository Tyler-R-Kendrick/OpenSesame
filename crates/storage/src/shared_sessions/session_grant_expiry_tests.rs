//! Which session grants one lifecycle pass reads (ADR 0079 §4, ADR 0074 §1).

use chrono::Duration;
use opensesame_domain::{
    GrantLink, GrantScope, NewSessionGrant, PrincipalId, SessionGrantId, SessionId, SessionRole,
    SessionVisibility, VaultId,
};

use super::*;
use crate::StoredSession;

const ORG: &str = "org:one";

async fn open(db: &Db, organization_id: &str) -> StoredSession {
    let session = StoredSession {
        id: SessionId::new(),
        organization_id: organization_id.into(),
        operator_principal_id: PrincipalId::new(),
        display_name: "Incident 4471".into(),
        visibility: SessionVisibility::Private,
        created_at: Utc::now() - Duration::days(2),
        closed_at: None,
    };
    db.create_session(&session).await.expect("session opens");
    session
}

async fn grant(db: &Db, session: &StoredSession, expires_at: DateTime<Utc>) -> SessionGrantId {
    let grant = SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id: session.id,
        subject_principal_id: PrincipalId::new(),
        granted_by_principal_id: session.operator_principal_id,
        scope: GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        role: SessionRole::Read,
        granted_at: expires_at - Duration::hours(1),
        expires_at,
        link: GrantLink::LifecycleBound,
    })
    .expect("a valid grant");
    db.insert_session_grant(&session.organization_id, &grant)
        .await
        .expect("grant");
    grant.id
}

#[tokio::test]
async fn a_pass_reads_live_grants_soonest_first_and_lapsed_ones_newest_first() {
    let db = Db::connect_memory().await.expect("db");
    let here = open(&db, ORG).await;
    let now = Utc::now();
    let mut issued = Vec::new();
    for (name, minutes) in [
        ("oldest-lapsed", -23 * 60),
        ("lapsed", -60),
        ("just-lapsed", -1),
        ("at-the-deadline", 0),
        ("soonest", 10),
        ("later", 50),
        ("latest", 120),
    ] {
        issued.push((
            grant(&db, &here, now + Duration::minutes(minutes)).await,
            name,
        ));
    }
    let withdrawn = grant(&db, &here, now + Duration::minutes(5)).await;
    db.revoke_session_grant(withdrawn, now)
        .await
        .expect("revoke");
    let elsewhere = open(&db, "org:two").await;
    grant(&db, &elsewhere, now + Duration::minutes(5)).await;

    let read = db.session_grants_expiring(ORG, now, 2).await.expect("read");
    let names: Vec<&str> = read
        .iter()
        .map(|row| {
            issued
                .iter()
                .find(|(id, _)| *id == row.id)
                .map_or("unexpected", |(_, name)| *name)
        })
        .collect();
    assert_eq!(
        names,
        ["soonest", "later", "at-the-deadline", "just-lapsed"]
    );
}
