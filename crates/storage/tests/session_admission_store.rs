//! A session's admission policy in the store (ADR 0137).
//!
//! Every session the operator opened before the policy existed keeps ADR
//! 0079 §7's rule; a spelling the domain does not know never lands; and the
//! discovery helper names only open, public sessions that admit on ask.

use chrono::Utc;
use opensesame_domain::{PrincipalId, SessionAdmission, SessionId, SessionVisibility};
use opensesame_storage::{Db, StoredSession};

const ORG: &str = "org:one";

fn session(visibility: SessionVisibility) -> StoredSession {
    StoredSession {
        id: SessionId::new(),
        organization_id: ORG.into(),
        operator_principal_id: PrincipalId::new(),
        display_name: "Lobby".into(),
        visibility,
        created_at: Utc::now(),
        closed_at: None,
    }
}

#[tokio::test]
async fn the_operator_decides_unless_the_session_says_otherwise() {
    let db = Db::connect_sqlite("sqlite::memory:").await.unwrap();
    let plain = session(SessionVisibility::Public);
    db.create_session(&plain).await.unwrap();
    let lobby = session(SessionVisibility::Public);
    db.create_session_admitting(&lobby, SessionAdmission::ObserverOnAsk)
        .await
        .unwrap();
    let private = session(SessionVisibility::Private);
    db.create_session(&private).await.unwrap();

    assert_eq!(
        db.session_admission(ORG, plain.id).await.unwrap(),
        SessionAdmission::Operator
    );
    assert_eq!(
        db.session_admission(ORG, lobby.id).await.unwrap(),
        SessionAdmission::ObserverOnAsk
    );
    let on_ask = db.sessions_admitting_on_ask(ORG).await.unwrap();
    assert_eq!(on_ask.into_iter().collect::<Vec<_>>(), vec![lobby.id]);
    // Scoped to the organization: another one's session is not found at all.
    assert!(db.session_admission("org:two", lobby.id).await.is_err());
}

#[tokio::test]
async fn a_spelling_the_domain_does_not_know_never_lands() {
    let db = Db::connect_sqlite("sqlite::memory:").await.unwrap();
    let lobby = session(SessionVisibility::Public);
    db.create_session(&lobby).await.unwrap();
    let refused = sqlx::query("UPDATE sessions SET admission = 'participant_on_ask' WHERE id = ?1")
        .bind(lobby.id.to_string())
        .execute(db.pool())
        .await;
    assert!(refused.is_err());
}
