//! Seats and endings through the real router (ADR 0079 §2, §7).
//!
//! Written as attempts, like the sibling suite: grant an observer, lower
//! somebody who still holds a key, close a session and see what survived,
//! close somebody else's.

use axum::http::StatusCode;
use opensesame_domain::{OrganizationId, PrincipalId, VaultId};
use serde_json::{json, Value};

use super::super::shared_sessions::tests::{
    actor, call, collection_grant, get, open_session, state, Actor,
};
use axum::Router;

fn members(id: &str) -> String {
    format!("/api/v1/shared-sessions/{id}/members")
}

async fn seat(
    router: &Router,
    id: &str,
    operator: &Actor,
    who: PrincipalId,
    mode: &str,
) -> (StatusCode, Value) {
    call(
        router,
        "POST",
        &members(id),
        operator,
        json!({"principal_id": who.to_string(), "mode": mode}),
    )
    .await
}

async fn close_session(router: &Router, id: &str, who: &Actor) -> (StatusCode, Value) {
    let path = format!("/api/v1/shared-sessions/{id}/close");
    call(router, "POST", &path, who, json!({})).await
}

// ---- SES-MODES -----------------------------------------------------------

#[tokio::test]
async fn an_observer_joins_a_session_without_being_handed_a_single_key() {
    // The ask, end to end. Somebody is in the room, sees who else is, and no
    // grant was minted anywhere — so nothing was wrapped for a key they do not
    // have, and there is nothing to re-key when they leave.
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let watcher = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (status, body) = seat(&router, &id, &operator, watcher.principal, "observer").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], json!("observer"));

    let (status, body) = get(&router, &members(&id), &watcher).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["members"].as_array().expect("a roster").len(), 1);
    assert_eq!(body["members"][0]["mode"], json!("observer"));

    // In the room, and holding nothing: the session's grant roster is empty.
    let (status, detail) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &watcher).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["participants"], json!([]));
}

#[tokio::test]
async fn an_observer_cannot_be_granted_and_a_raised_one_can() {
    // The refusal is at the minting, not at the read, because a grant is a
    // wrapped key and ADR 0079 §3's revocation is re-keying: a key wrapped for
    // somebody who needed none cannot be taken back.
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let watcher = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    let grants = format!("/api/v1/shared-sessions/{id}/grants");
    seat(&router, &id, &operator, watcher.principal, "observer").await;

    let (status, body) = call(
        &router,
        "POST",
        &grants,
        &operator,
        collection_grant(watcher.principal, VaultId::new()),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("grant_subject"));

    // Raising is the deliberate act that makes it possible, and it is separate
    // from granting: it says they may be given keys, not that they have any.
    let (status, body) = seat(&router, &id, &operator, watcher.principal, "participant").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, detail) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &watcher).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        detail["participants"],
        json!([]),
        "raising somebody handed them reach"
    );

    let (status, body) = call(
        &router,
        "POST",
        &grants,
        &operator,
        collection_grant(watcher.principal, VaultId::new()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
async fn lowering_somebody_who_still_holds_reach_is_refused_rather_than_revoked_for_them() {
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
    let grant_id = body["grant"]["grant_id"]
        .as_str()
        .expect("a grant")
        .to_string();

    let (status, body) = seat(&router, &id, &operator, alice.principal, "observer").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // Revoking is the act with the consequence — re-keying — so the operator
    // performs it rather than having it happen on their behalf.
    call(
        &router,
        "DELETE",
        &format!("/api/v1/shared-sessions/{id}/grants/{grant_id}"),
        &operator,
        json!({}),
    )
    .await;
    let (status, body) = seat(&router, &id, &operator, alice.principal, "observer").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], json!("observer"));
}

#[tokio::test]
async fn seating_is_the_operators_alone_and_never_of_themselves() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    seat(&router, &id, &operator, alice.principal, "participant").await;

    // The operator runs the session rather than sitting in it.
    let (status, body) = seat(&router, &id, &operator, operator.principal, "observer").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("member_principal"));

    // A participant is not an operator, and a stranger is told the session
    // does not exist rather than that they are not allowed to seat people.
    for who in [&alice, &stranger] {
        let (status, _) = seat(&router, &id, who, PrincipalId::new(), "observer").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

// ---- SES-ADMIT -----------------------------------------------------------

async fn ask_and_get_request_id(router: &Router, id: &str, asker: &Actor) -> String {
    let (status, body) = call(
        router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        asker,
        json!({"note": "shadowing this deploy"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    body["id"].as_str().expect("an id").to_string()
}

#[tokio::test]
async fn a_stranger_is_admitted_as_an_observer_and_no_grant_is_minted() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;
    let request_id = ask_and_get_request_id(&router, &id, &stranger).await;

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide"),
        &operator,
        json!({"decision": "admitted", "mode": "observer"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["decision"], json!("admitted"));
    assert_eq!(body["mode"], json!("observer"));
    assert_eq!(body["grant"], Value::Null, "an observer was handed a key");

    // Admitted means in the room, which is what the seat says.
    let (status, seats) = get(&router, &members(&id), &stranger).await;
    assert_eq!(status, StatusCode::OK, "{seats}");
    assert_eq!(seats["members"][0]["mode"], json!("observer"));
}

#[tokio::test]
async fn an_admission_must_say_which_seat_it_gives() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let stranger = actor(&st, org);
    let id = open_session(&router, &operator, "public").await;
    let request_id = ask_and_get_request_id(&router, &id, &stranger).await;
    let decide = format!("/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide");

    // No mode at all: the field that decides whether somebody may be given
    // keys is not something a missing value gets to answer.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({"decision": "admitted"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // An observer admission carrying a grant: the contradiction that would
    // wrap a key for somebody the operator just said needs none.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({
            "decision": "admitted",
            "mode": "observer",
            "grant": {
                "scope": {"kind": "collection", "vault_id": VaultId::new().to_string()},
                "role": "read",
                "expires_at": (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339(),
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // A participant admission with no grant: still the shape that would let
    // the roster and the request log disagree.
    let (status, body) = call(
        &router,
        "POST",
        &decide,
        &operator,
        json!({"decision": "admitted", "mode": "participant"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // And after three refusals the request is still pending, so none of them
    // consumed the operator's chance to decide it properly.
    let (status, waiting) = get(
        &router,
        &format!("/api/v1/shared-sessions/{id}/join-requests"),
        &operator,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{waiting}");
    assert_eq!(waiting["requests"].as_array().expect("a queue").len(), 1);
}

// ---- SES-END -------------------------------------------------------------

#[tokio::test]
async fn closing_ends_the_room_for_everybody_but_the_operator() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let watcher = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, VaultId::new()),
    )
    .await;
    seat(&router, &id, &operator, watcher.principal, "observer").await;

    let (status, body) = close_session(&router, &id, &operator).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["already_closed"], json!(false));
    // Revocation is re-keying, not a switch, and closing is the moment an
    // operator is most likely to believe otherwise.
    assert!(
        body["note"].as_str().expect("a note").contains("Re-key"),
        "{body}"
    );

    for who in [&alice, &watcher] {
        let (status, _) = get(&router, &format!("/api/v1/shared-sessions/{id}"), who).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // The operator keeps their standing so they can read what happened. It is
    // a management role and has never been a reach into the vault, so the
    // roster they see is empty of live grants.
    let (status, detail) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["closed_at"].is_string());
    assert_eq!(
        detail["participants"],
        json!([]),
        "closing left the reach the session minted alive"
    );
}

#[tokio::test]
async fn closing_is_idempotent_and_a_closed_session_grants_nothing_further() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;

    let (status, _) = close_session(&router, &id, &operator).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = close_session(&router, &id, &operator).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["already_closed"], json!(true));

    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(PrincipalId::new(), VaultId::new()),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], json!("session_closed"));

    let (status, body) = seat(&router, &id, &operator, PrincipalId::new(), "observer").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn a_participant_cannot_close_the_session() {
    let st = state().await;
    let router = super::super::router(st.clone());
    let org = OrganizationId::new();
    let operator = actor(&st, org);
    let alice = actor(&st, org);
    let id = open_session(&router, &operator, "private").await;
    call(
        &router,
        "POST",
        &format!("/api/v1/shared-sessions/{id}/grants"),
        &operator,
        collection_grant(alice.principal, VaultId::new()),
    )
    .await;

    let (status, _) = close_session(&router, &id, &alice).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, detail) = get(&router, &format!("/api/v1/shared-sessions/{id}"), &operator).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["closed_at"], Value::Null);
}
