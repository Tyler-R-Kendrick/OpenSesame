//! `GET|PUT /api/v1/agent-hooks/approver`: who an escalated action is put to
//! is read by owner/admin or the operator, replaced only with a step-up,
//! compare-and-set, and audited without the handle (ADR 0159).

use super::*;
use crate::agent_hook_approver::{ApproverSettings, ENV_BEARER, ENV_REF, ENV_URL};
use step_up::STEP_UP_REQUIRED;

const APPROVER: &str = "/api/v1/agent-hooks/approver";
const HANDLE: &str = "inbox_YXBwcm92ZXI.test-tag";
const DEFAULT_HANDLE: &str = "inbox_ZGVmYXVsdA.default-tag";

fn body(handle: Option<&str>) -> Vec<u8> {
    json!({ "approver_ref": handle }).to_string().into_bytes()
}

async fn put(app: &Router, caller: &HeaderMap, version: &str, bytes: Vec<u8>) -> Reply {
    let headers = with(caller.clone(), "if-match", version);
    send(app, &headers, "PUT", APPROVER, bytes).await
}

fn configured(st: &mut AppState, default_ref: Option<&str>) {
    let lookup = |name: &str| match name {
        ENV_URL => Some("http://127.0.0.1:9".to_owned()),
        ENV_BEARER => Some("requester-bearer-value".to_owned()),
        ENV_REF => default_ref.map(str::to_owned),
        _ => None,
    };
    st.agent_hook_approver = ApproverSettings::from_lookup(&lookup)
        .unwrap()
        .map(Into::into);
}

async fn stored(
    st: &AppState,
) -> Option<opensesame_storage::agent_hook_policy::approver::StoredAgentHookApprover> {
    st.db
        .agent_hook_approver(&st.connection_organization.to_string())
        .await
        .unwrap()
}

#[tokio::test]
async fn an_unset_approver_reads_as_nobody_at_version_zero() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let reply = send(&app, &operator(&st), "GET", APPROVER, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["version"], 0);
    assert_eq!(reply.body["stored"], false);
    assert_eq!(reply.body["asks"], "nobody");
    assert_eq!(reply.body["transport_configured"], false);
    assert_eq!(reply.body["approver_ref"], Value::Null);
    assert_eq!(reply.headers[header::ETAG], "\"0\"");
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn the_operator_sets_reads_and_clears_it_compare_and_set() {
    let mut st = test_demo_state().await;
    configured(&mut st, None);
    let app = crate::routes::router(st.clone());
    let operator = operator(&st);

    let set = put(&app, &operator, "\"0\"", body(Some(HANDLE))).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    assert_eq!(set.body["version"], 1);
    assert_eq!(set.body["approver_ref"], HANDLE);
    assert_eq!(set.body["asks"], "organization");
    assert_eq!(set.body["transport_configured"], true);
    assert_eq!(set.body["updated_by"], "operator");

    let read = send(&app, &operator, "GET", APPROVER, Vec::new()).await;
    assert_eq!(read.body, set.body);
    assert_eq!(read.headers[header::ETAG], "\"1\"");

    // A stale version loses and changes nothing.
    let stale = put(&app, &operator, "\"0\"", body(Some("inbox_b3RoZXI.other"))).await;
    assert_eq!(stale.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(stale.body["current_version"], 1);
    assert_eq!(
        stored(&st).await.unwrap().approver_ref.as_deref(),
        Some(HANDLE)
    );

    let cleared = put(&app, &operator, "\"1\"", body(None)).await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
    assert_eq!(cleared.body["version"], 2);
    assert_eq!(cleared.body["approver_ref"], Value::Null);
    assert_eq!(cleared.body["asks"], "nobody");
}

#[tokio::test]
async fn the_operators_default_is_named_but_never_shown() {
    let mut st = test_demo_state().await;
    configured(&mut st, Some(DEFAULT_HANDLE));
    let app = crate::routes::router(st.clone());
    let operator = operator(&st);
    let before = send(&app, &operator, "GET", APPROVER, Vec::new()).await;
    assert_eq!(before.body["asks"], "operator_default");
    assert_eq!(before.body["approver_ref"], Value::Null);
    assert!(!before.body.to_string().contains(DEFAULT_HANDLE));

    // Naming nobody is a decision, not a fall-through to the default.
    put(&app, &operator, "\"0\"", body(None)).await;
    let after = send(&app, &operator, "GET", APPROVER, Vec::new()).await;
    assert_eq!(after.body["asks"], "nobody");
}

#[tokio::test]
async fn replacing_it_takes_a_step_up_and_reading_does_not() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let org = st.connection_organization;
    let plain = test_session_headers(&st, P27, org, OrganizationRole::Admin);
    assert_eq!(
        send(&app, &plain, "GET", APPROVER, Vec::new()).await.status,
        StatusCode::OK
    );
    let refused = put(&app, &plain, "\"0\"", body(Some(HANDLE))).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(refused.body["error"], STEP_UP_REQUIRED);
    assert_eq!(refused.body["reason"], "no_step_up");
    let hint = refused.body["hint"].as_str().unwrap_or_default();
    assert!(hint.contains("change who approves"), "{hint}");
    assert_eq!(stored(&st).await, None);
    assert_eq!(st.db.count_unpublished_outbox().await.unwrap(), 0);

    let admin = stepped_up(&st, P27, org, OrganizationRole::Admin);
    let ok = put(&app, &admin, "\"0\"", body(Some(HANDLE))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(ok.body["updated_by"], P27);

    // A delegated credential never satisfies it, however fresh.
    let delegated = session_shaped(&st, P28, org, OrganizationRole::Owner, |claims| {
        step_up_taken(claims, 0);
        claims.capability_ceiling.push("host.tasks.invoke".into());
    });
    let refused = put(&app, &delegated, "\"1\"", body(None)).await;
    assert_eq!(refused.body["reason"], "delegated_credential");
    assert_eq!(stored(&st).await.unwrap().version, 1);
}

#[tokio::test]
async fn a_member_an_anonymous_caller_and_an_agent_are_refused() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let org = st.connection_organization;
    let none = send(&app, &HeaderMap::new(), "GET", APPROVER, Vec::new()).await;
    assert_eq!(none.status, StatusCode::UNAUTHORIZED);
    let member = stepped_up(&st, P26, org, OrganizationRole::Member);
    assert_eq!(
        send(&app, &member, "GET", APPROVER, Vec::new())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let reply = put(&app, &member, "\"0\"", body(Some(HANDLE))).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["error"], "forbidden", "role is judged first");
    assert_eq!(stored(&st).await, None);

    // An agent capability never reaches it, whatever role it carries.
    let token = "c".repeat(64);
    let mut agent = crate::session_claims::fixture(
        crate::session_claims::parse_principal(P27).unwrap(),
        org,
        OrganizationRole::Owner,
        &st.resource,
    );
    step_up_taken(&mut agent, 0);
    agent.credential_kind = CredentialKind::AgentCapability;
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&token), agent);
    let headers = with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer agent-capability:{token}"),
    );
    for method in ["GET", "PUT"] {
        let reply = send(&app, &headers, method, APPROVER, body(Some(HANDLE))).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method}");
    }
    let direct = approver::put_approver(State(st.clone()), headers, Body::from(body(None))).await;
    assert_eq!(direct.status(), StatusCode::FORBIDDEN);
    assert_eq!(stored(&st).await, None);
}

#[tokio::test]
async fn a_body_that_is_not_exactly_one_handle_or_null_is_refused() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let operator = operator(&st);
    let long = format!("inbox_{}", "a".repeat(260));
    let bad: Vec<Vec<u8>> = vec![
        b"{}".to_vec(),
        b"[]".to_vec(),
        b"null".to_vec(),
        b"not json".to_vec(),
        br#"{"approver_ref": 7}"#.to_vec(),
        br#"{"approver_ref": "inbox_x"}"#.to_vec(),
        br#"{"approver_ref": "https://elsewhere.example/inbox_abcdefgh"}"#.to_vec(),
        br#"{"approver_ref": "inbox_has space"}"#.to_vec(),
        br#"{"approver_ref": "notinbox_abcdefgh"}"#.to_vec(),
        body(Some(&long)),
        br#"{"approver_ref": null, "extra": 1}"#.to_vec(),
    ];
    for bytes in bad {
        let reply = put(&app, &operator, "\"0\"", bytes.clone()).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{}: {}",
            String::from_utf8_lossy(&bytes),
            reply.body
        );
        assert_eq!(reply.body["error"], "invalid_approver");
    }
    let oversized = put(&app, &operator, "\"0\"", vec![b' '; 5 * 1024]).await;
    assert_eq!(oversized.status, StatusCode::PAYLOAD_TOO_LARGE);
    let no_tag = send(&app, &operator, "PUT", APPROVER, body(Some(HANDLE))).await;
    assert_eq!(no_tag.status, StatusCode::PRECONDITION_REQUIRED);
    assert_eq!(stored(&st).await, None);
}

#[tokio::test]
async fn the_audit_event_commits_with_the_row_and_never_carries_the_handle() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let reply = put(&app, &operator(&st), "\"0\"", body(Some(HANDLE))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let (id, organization, payload): (String, String, String) = sqlx::query_as(
        "SELECT id, organization_id, payload_json FROM outbox_events WHERE event_type = ?",
    )
    .bind(crate::agent_hook_approver::EVENT_APPROVER_UPDATED)
    .fetch_one(st.db.pool())
    .await
    .unwrap();
    // Sealed at rest once the process-wide sealer is installed (ADR 0157); the
    // assertion below means something only on the opened text.
    let payload =
        opensesame_event_seal::open_in(&organization, "outbox_events.payload_json", &id, &payload)
            .unwrap();
    assert!(!payload.contains(HANDLE), "{payload}");
    let audit: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(audit["updated_by"], "operator");
    assert_eq!(
        (
            audit["previous_version"].as_i64(),
            audit["version"].as_i64()
        ),
        (Some(0), Some(1))
    );
    assert_eq!(
        audit["approver_sha256"],
        hex::encode(Sha256::digest(HANDLE.as_bytes()))
    );
    // A lost race leaves no event behind.
    put(&app, &operator(&st), "\"0\"", body(None)).await;
    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE event_type = ?")
        .bind(crate::agent_hook_approver::EVENT_APPROVER_UPDATED)
        .fetch_one(st.db.pool())
        .await
        .unwrap();
    assert_eq!(events, 1);
}
