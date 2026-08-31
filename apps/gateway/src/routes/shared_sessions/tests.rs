//! Shared-session routes end to end, through the real router (ADR 0079).
//!
//! Each case is written as an attempt rather than a happy path: read a private
//! session you were not invited to, revoke a grant on somebody else's session,
//! admit one person and grant another, learn the roster by asking to join.

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId, VaultId, VaultItemId};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::app_state::{self, AppState};
use crate::config::Args;

/// A caller: a principal, the bearer that speaks for them, and their org.
struct Actor {
    principal: PrincipalId,
    bearer: String,
}

async fn state() -> AppState {
    app_state::build(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .expect("state builds")
}

/// Mint a session for one principal in one organization.
///
/// This writes the session map directly rather than going through
/// `/session/local`, because what is under test is the shared-session fence,
/// not how a bearer is obtained.
fn actor(st: &AppState, organization: OrganizationId) -> Actor {
    let principal = PrincipalId::new();
    let opaque = format!("sess_{}", uuid::Uuid::new_v4());
    let digest = opensesame_claims::hash_secret(&opaque);
    st.sessions.lock().unwrap().insert(
        digest,
        json!({
            "principal_id": principal.to_string(),
            "approved_as": principal.to_string(),
            "organization_id": organization.to_string(),
            "organization_role": OrganizationRole::Member,
            "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
        }),
    );
    Actor {
        principal,
        bearer: format!("Bearer opaque-session:{opaque}"),
    }
}

async fn call(
    router: &Router,
    method: &str,
    path: &str,
    actor: &Actor,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", &actor.bearer)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let parsed = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, parsed)
}

async fn get(router: &Router, path: &str, actor: &Actor) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("GET")
        .uri(path)
        .header("authorization", &actor.bearer)
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let parsed = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, parsed)
}

/// Open a session and return its id.
async fn open_session(router: &Router, operator: &Actor, visibility: &str) -> String {
    let (status, body) = call(
        router,
        "POST",
        "/api/v1/shared-sessions",
        operator,
        json!({"display_name": "Incident 4471", "visibility": visibility}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_str().expect("an id").to_string()
}

fn collection_grant(subject: PrincipalId, vault_id: VaultId) -> Value {
    json!({
        "subject_principal_id": subject.to_string(),
        "scope": {"kind": "collection", "vault_id": vault_id.to_string()},
        "role": "read",
        "expires_at": (Utc::now() + Duration::hours(2)).to_rfc3339(),
    })
}

#[tokio::test]
async fn an_operator_opens_a_session_and_sees_it() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);

    let id = open_session(&router, &operator, "private").await;
    let (status, body) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["operator_principal_id"],
        json!(operator.principal.to_string())
    );
    assert_eq!(body["participants"], json!([]));
}

#[tokio::test]
async fn a_stranger_is_told_a_private_session_does_not_exist() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);

    let id = open_session(&router, &operator, "private").await;
    let (status, body) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &stranger).await;
    // 404, not 403. A 403 would confirm the session exists, which is most of
    // what a stranger wants to learn about a private one.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], json!("session_not_found"));
}

#[tokio::test]
async fn a_session_is_invisible_across_organizations_even_to_its_own_operator() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;

    // The same person, signed in against a different organization.
    let elsewhere = actor(&st, OrganizationId::new());
    let (status, _) = get(
        &router,
        &format!("/api/v1/shared-sessions/{id}"),
        &elsewhere,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_participant_sees_the_roster_but_not_another_participants_scope() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let bob = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    let vault_id = VaultId::new();
    let bobs_row = VaultItemId::new();

    // Alice gets the whole collection; Bob gets one row.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, vault_id),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        json!({
            "subject_principal_id": bob.principal.to_string(),
            "scope": {
                "kind": "rows",
                "vault_id": vault_id.to_string(),
                "items": [bobs_row.to_string()],
            },
            "role": "read",
            "expires_at": (Utc::now() + Duration::hours(2)).to_rfc3339(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Bob, granted one row, sees who else is here and in what role.
    let (status, body) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &bob).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let participants = body["participants"].as_array().expect("a roster");
    assert_eq!(participants.len(), 2);
    for entry in participants {
        assert!(entry.get("principal_id").is_some());
        assert!(entry.get("role").is_some());
        // And nothing about what anybody reaches. A person granted one row
        // must not learn from the roster that a colleague holds the vault.
        assert!(
            entry.get("scope").is_none(),
            "the roster published a participant's scope: {entry}"
        );
        assert!(entry.get("grant_id").is_none());
    }
    let rendered = body.to_string();
    assert!(
        !rendered.contains(&vault_id.to_string()),
        "the roster named the vault to a participant"
    );

    // The operator sees everything they granted, scope included.
    let (status, body) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(status, StatusCode::OK);
    for entry in body["participants"].as_array().expect("a roster") {
        assert!(entry.get("scope").is_some(), "the operator lost the scope");
    }
}

#[tokio::test]
async fn a_participant_cannot_grant_and_cannot_revoke() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let outsider = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    let vault_id = VaultId::new();

    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, vault_id),
    )
    .await;
    let grant_id = body["grant"]["grant_id"].as_str().expect("a grant id");

    // Alice is in the session and still may not extend it to anybody.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &alice,
        collection_grant(outsider.principal, vault_id),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/shared-sessions/{id}/grants/{grant_id}"),
        &alice,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_grant_cannot_be_revoked_by_naming_it_under_another_session() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let victim = actor(&st, org);
    let attacker = actor(&st, org);
    let vault_id = VaultId::new();

    let theirs = open_session(&router, &victim, "private").await;
    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{theirs}/grants"),
        &victim,
        collection_grant(PrincipalId::new(), vault_id),
    )
    .await;
    let grant_id = body["grant"]["grant_id"].as_str().expect("a grant id");

    // The attacker runs their own session in the same organization, and names
    // a grant that belongs to somebody else's under it.
    let mine = open_session(&router, &attacker, "private").await;
    let (status, _) = call(
        &router,
        "DELETE",
        &format!("/api/v1/shared-sessions/{mine}/grants/{grant_id}"),
        &attacker,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // And it is still live.
    let (_, body) = get(
        &router,
        &format!("/api/v1/shared-sessions/{theirs}"),
        &victim,
    )
    .await;
    assert_eq!(body["participants"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn an_over_long_grant_is_refused_rather_than_clamped() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        json!({
            "subject_principal_id": PrincipalId::new().to_string(),
            "scope": {"kind": "collection", "vault_id": VaultId::new().to_string()},
            "role": "read",
            "expires_at": (Utc::now() + Duration::days(30)).to_rfc3339(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], json!("grant_refused"));

    // Nothing was written under a quietly shortened lifetime.
    let (_, body) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(body["participants"], json!([]));
}

#[tokio::test]
async fn an_empty_row_scope_is_refused() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        json!({
            "subject_principal_id": PrincipalId::new().to_string(),
            "scope": {"kind": "rows", "vault_id": VaultId::new().to_string(), "items": []},
            "role": "read",
            "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn discovery_advertises_a_name_and_nothing_else() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);

    let public = open_session(&router, &operator, "public").await;
    let private = open_session(&router, &operator, "private").await;

    let (status, body) = get(
        &router,
        "/api/v1/shared-sessions?visibility=public",
        &stranger,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let listed = body["sessions"].as_array().expect("a list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], json!(public));
    assert_eq!(listed[0]["display_name"], json!("Incident 4471"));
    // A name and an id. Not who runs it, not what is in it (ADR 0079 §7).
    assert_eq!(
        listed[0].as_object().unwrap().len(),
        2,
        "the discovery record grew a field: {}",
        listed[0]
    );
    let rendered = body.to_string();
    assert!(!rendered.contains(&private), "a private session was listed");
    assert!(
        !rendered.contains(&operator.principal.to_string()),
        "discovery named the operator"
    );
}

#[tokio::test]
async fn discovery_refuses_to_default_to_listing_anything() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    open_session(&router, &operator, "private").await;

    for query in ["", "?visibility=private", "?visibility=all"] {
        let (status, _) = get(
            &router,
            &format!("/api/v1/shared-sessions{query}"),
            &operator,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "discovery answered `{query}`"
        );
    }
}

#[tokio::test]
async fn a_pending_requester_learns_only_that_they_are_pending() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;
    call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, VaultId::new()),
    )
    .await;

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &stranger,
        json!({"note": "on call for the incident"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["decision"], json!("pending"));

    // Admission precedes connection: no roster, no session detail.
    let (status, _) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &stranger).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // And not the queue of other people waiting, either.
    let (status, _) = get(
        &router,
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &stranger,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_private_session_cannot_be_probed_through_the_join_route() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &stranger,
        json!({}),
    )
    .await;
    // Identical to the answer for a session id that was never issued.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], json!("session_not_found"));
}

#[tokio::test]
async fn asking_twice_is_the_same_ask() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;
    let path = format!("/api/v1/shared-sessions/{id}/join-requests");

    let (first, _) = call(&router, "POST", &path, &stranger, json!({})).await;
    assert_eq!(first, StatusCode::ACCEPTED);
    let (second, body) = call(&router, "POST", &path, &stranger, json!({})).await;
    assert_eq!(second, StatusCode::CONFLICT);
    assert_eq!(body["error"], json!("join_request_pending"));

    let (_, listed) = get(&router, &path, &operator).await;
    assert_eq!(listed["requests"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn admitting_one_person_cannot_grant_another() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let asker = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;

    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &asker,
        json!({}),
    )
    .await;
    let request_id = body["id"].as_str().expect("a request id").to_string();
    let decide = format!("/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide");
    let vault_id = VaultId::new();

    // Naming somebody else as the subject is refused outright rather than
    // silently ignored: an operator who typed the wrong principal is told.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({
            "decision": "admitted",
            "grant": {
                "subject_principal_id": PrincipalId::new().to_string(),
                "scope": {"kind": "collection", "vault_id": vault_id.to_string()},
                "role": "read",
                "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // Without one, the requester is the subject, structurally.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({
            "decision": "admitted",
            "grant": {
                "scope": {"kind": "collection", "vault_id": vault_id.to_string()},
                "role": "read",
                "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["grant"]["principal_id"],
        json!(asker.principal.to_string())
    );

    // And the admitted person is now in the session.
    let (status, _) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &asker).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_admission_without_a_grant_and_a_refusal_with_one_are_both_refused() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let asker = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;

    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &asker,
        json!({}),
    )
    .await;
    let request_id = body["id"].as_str().unwrap().to_string();
    let decide = format!("/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide");

    let (status, _) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({"decision": "admitted"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, _) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({
            "decision": "refused",
            "grant": {
                "scope": {"kind": "collection", "vault_id": VaultId::new().to_string()},
                "role": "read",
                "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Still pending after both attempts.
    let (_, listed) = get(
        &router,
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &operator,
    )
    .await;
    assert_eq!(listed["requests"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_decided_request_is_not_decided_again() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let asker = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;

    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &asker,
        json!({}),
    )
    .await;
    let request_id = body["id"].as_str().unwrap().to_string();
    let decide = format!("/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide");

    let (status, _) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({"decision": "refused"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A second operator (or a retried click) cannot turn a refusal into an
    // admission after the fact.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({
            "decision": "admitted",
            "grant": {
                "scope": {"kind": "collection", "vault_id": VaultId::new().to_string()},
                "role": "read",
                "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (_, detail) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(detail["participants"], json!([]));
}

#[tokio::test]
async fn revoking_says_what_it_does_not_undo() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (_, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, VaultId::new()),
    )
    .await;
    let grant_id = body["grant"]["grant_id"].as_str().unwrap().to_string();
    let path = format!("/api/v1/shared-sessions/{id}/grants/{grant_id}");

    let (status, body) = call(&router, "DELETE", &path, &operator, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    // Revocation is re-keying, not a switch (ADR 0079 §3). The wire says so.
    let note = body["note"].as_str().expect("a note");
    assert!(note.contains("Re-key"), "{note}");

    // Alice is out.
    let (status, _) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &alice).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // And revoking again is the same answer, not an error to retry against.
    let (status, _) = call(&router, "DELETE", &path, &operator, json!({})).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_operator_token_cannot_act_as_a_session_operator() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/shared-sessions")
        .header(
            "authorization",
            format!("Bearer operator:{}", st.operator_token),
        )
        .header("content-type", "application/json")
        .body(Body::from(json!({"display_name": "Incident"}).to_string()))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    // A machine credential has nobody behind it, and a shared session is
    // between people. Refused with its own reason rather than a 404.
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
