//! The shared-session schema's constraints, exercised (ADR 0079).
//!
//! Migration 0020 encodes three properties the domain types already hold, so
//! that a caller reaching the database by another path — a repair script, a
//! future repository, a hand-written statement — cannot contradict them. A
//! CHECK nobody has watched refuse is a CHECK nobody knows works, so each one
//! here is asserted by trying to violate it.

use opensesame_storage::Db;

async fn db() -> Db {
    Db::connect_sqlite("sqlite::memory:")
        .await
        .expect("migrations apply")
}

/// A session to hang grants and requests off.
async fn seed_session(db: &Db) -> String {
    let id = "session:one".to_string();
    sqlx::query(
        "INSERT INTO sessions (id, organization_id, project_id, \
         operator_principal_id, display_name, visibility, created_at) \
         VALUES (?1, 'org:one', NULL, 'principal:op', 'Incident 4471', \
         'private', '2026-08-31T12:00:00Z')",
    )
    .bind(&id)
    .execute(db.pool())
    .await
    .expect("session inserts");
    id
}

async fn insert_grant(
    db: &Db,
    session_id: &str,
    id: &str,
    granted_at: &str,
    expires_at: Option<&str>,
) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
    sqlx::query(
        "INSERT INTO session_grants (id, session_id, organization_id, \
         subject_principal_id, granted_by_principal_id, scope_kind, vault_id, \
         role, granted_at, expires_at) \
         VALUES (?1, ?2, 'org:one', 'principal:holder', 'principal:op', \
         'collection', 'vault:one', 'read', ?3, ?4)",
    )
    .bind(id)
    .bind(session_id)
    .bind(granted_at)
    .bind(expires_at)
    .execute(db.pool())
    .await
}

#[tokio::test]
async fn a_grant_without_an_expiry_is_refused_by_the_database() {
    // There is no standing session grant: revocation is re-keying rather than
    // a switch, so a grant that never lapses is a key handed out permanently.
    // `SessionGrant` carries a timestamp rather than an Option, and the column
    // is NOT NULL so no other writer can express one either.
    let db = db().await;
    let session_id = seed_session(&db).await;
    let error = insert_grant(
        &db,
        &session_id,
        "sgrant:none",
        "2026-08-31T12:00:00Z",
        None,
    )
    .await
    .expect_err("a null expiry must be refused");
    assert!(
        error.to_string().to_lowercase().contains("not null"),
        "expected a NOT NULL violation, got {error}"
    );
}

#[tokio::test]
async fn a_grant_that_expires_before_it_starts_is_refused() {
    let db = db().await;
    let session_id = seed_session(&db).await;
    for expires_at in ["2026-08-31T12:00:00Z", "2026-08-30T00:00:00Z"] {
        let outcome = insert_grant(
            &db,
            &session_id,
            "sgrant:backwards",
            "2026-08-31T12:00:00Z",
            Some(expires_at),
        )
        .await;
        assert!(
            outcome.is_err(),
            "expiry {expires_at} is not after granted_at and must be refused"
        );
    }
}

#[tokio::test]
async fn a_grant_names_each_row_once() {
    let db = db().await;
    let session_id = seed_session(&db).await;
    insert_grant(
        &db,
        &session_id,
        "sgrant:rows",
        "2026-08-31T12:00:00Z",
        Some("2026-08-31T20:00:00Z"),
    )
    .await
    .expect("grant inserts");

    let insert_item = |item: &'static str| {
        sqlx::query(
            "INSERT INTO session_grant_items (grant_id, item_id) VALUES ('sgrant:rows', ?1)",
        )
        .bind(item)
        .execute(db.pool())
    };
    insert_item("item:a").await.expect("first row");
    assert!(
        insert_item("item:a").await.is_err(),
        "the same row twice in one grant is a mistake, not a stronger grant"
    );
}

#[tokio::test]
async fn admission_without_the_grant_it_minted_is_refused() {
    // Admission IS a grant — there is no "in the room with nothing" — so the
    // decision and the grant it produced cannot drift apart.
    let db = db().await;
    let session_id = seed_session(&db).await;
    let outcome = sqlx::query(
        "INSERT INTO session_join_requests (id, session_id, organization_id, \
         requester_principal_id, requested_at, decision, decided_at, \
         decided_by_principal_id, grant_id) \
         VALUES ('joinreq:one', ?1, 'org:one', 'principal:stranger', \
         '2026-08-31T12:00:00Z', 'admitted', '2026-08-31T12:05:00Z', \
         'principal:op', NULL)",
    )
    .bind(&session_id)
    .execute(db.pool())
    .await;
    assert!(
        outcome.is_err(),
        "an admitted request with no grant must be refused"
    );
}

#[tokio::test]
async fn a_refusal_carries_no_grant() {
    let db = db().await;
    let session_id = seed_session(&db).await;
    insert_grant(
        &db,
        &session_id,
        "sgrant:stray",
        "2026-08-31T12:00:00Z",
        Some("2026-08-31T20:00:00Z"),
    )
    .await
    .expect("grant inserts");

    let outcome = sqlx::query(
        "INSERT INTO session_join_requests (id, session_id, organization_id, \
         requester_principal_id, requested_at, decision, decided_at, \
         decided_by_principal_id, grant_id) \
         VALUES ('joinreq:refused', ?1, 'org:one', 'principal:stranger', \
         '2026-08-31T12:00:00Z', 'refused', '2026-08-31T12:05:00Z', \
         'principal:op', 'sgrant:stray')",
    )
    .bind(&session_id)
    .execute(db.pool())
    .await;
    assert!(
        outcome.is_err(),
        "a refusal that points at a grant is a contradiction"
    );
}

#[tokio::test]
async fn a_pending_request_has_decided_neither_when_nor_by_whom() {
    let db = db().await;
    let session_id = seed_session(&db).await;
    let outcome = sqlx::query(
        "INSERT INTO session_join_requests (id, session_id, organization_id, \
         requester_principal_id, requested_at, decision, decided_at, \
         decided_by_principal_id) \
         VALUES ('joinreq:half', ?1, 'org:one', 'principal:stranger', \
         '2026-08-31T12:00:00Z', 'pending', '2026-08-31T12:05:00Z', NULL)",
    )
    .bind(&session_id)
    .execute(db.pool())
    .await;
    assert!(
        outcome.is_err(),
        "a pending request that records when it was decided is half-written"
    );
}

#[tokio::test]
async fn asking_twice_is_the_same_ask() {
    // A queue an operator has to scroll is a queue an operator stops reading,
    // and a stranger who can flood it decides what the operator sees.
    let db = db().await;
    let session_id = seed_session(&db).await;
    let ask = |id: &'static str| {
        sqlx::query(
            "INSERT INTO session_join_requests (id, session_id, organization_id, \
             requester_principal_id, requested_at, decision) \
             VALUES (?1, ?2, 'org:one', 'principal:stranger', \
             '2026-08-31T12:00:00Z', 'pending')",
        )
        .bind(id)
        .bind(session_id.clone())
        .execute(db.pool())
    };
    ask("joinreq:first").await.expect("first ask");
    assert!(
        ask("joinreq:second").await.is_err(),
        "a second pending request from the same principal must be refused"
    );
}

#[tokio::test]
async fn a_decided_request_leaves_room_for_a_fresh_ask() {
    // The flood guard is on *pending* requests only: somebody refused once may
    // ask again later, and that new ask is a new row rather than an edit of
    // the old one, so the audit trail cannot be rewritten in place.
    let db = db().await;
    let session_id = seed_session(&db).await;
    sqlx::query(
        "INSERT INTO session_join_requests (id, session_id, organization_id, \
         requester_principal_id, requested_at, decision, decided_at, \
         decided_by_principal_id) \
         VALUES ('joinreq:refused-once', ?1, 'org:one', 'principal:stranger', \
         '2026-08-31T12:00:00Z', 'refused', '2026-08-31T12:05:00Z', \
         'principal:op')",
    )
    .bind(&session_id)
    .execute(db.pool())
    .await
    .expect("a refusal is recorded");

    sqlx::query(
        "INSERT INTO session_join_requests (id, session_id, organization_id, \
         requester_principal_id, requested_at, decision) \
         VALUES ('joinreq:asking-again', ?1, 'org:one', 'principal:stranger', \
         '2026-09-01T09:00:00Z', 'pending')",
    )
    .bind(&session_id)
    .execute(db.pool())
    .await
    .expect("asking again after a refusal is allowed");
}

#[tokio::test]
async fn a_session_is_private_or_public_and_nothing_else() {
    let db = db().await;
    let outcome = sqlx::query(
        "INSERT INTO sessions (id, organization_id, operator_principal_id, \
         display_name, visibility, created_at) \
         VALUES ('session:odd', 'org:one', 'principal:op', 'Odd', \
         'unlisted', '2026-08-31T12:00:00Z')",
    )
    .execute(db.pool())
    .await;
    assert!(
        outcome.is_err(),
        "a third visibility would be a third set of rules nobody wrote"
    );
}
