//! Replacing the policy takes the operator or a fresh step-up, whatever role
//! a caller holds; and each class of caller gets its own answer (ADR 0159,
//! ADR 0146).

use super::*;
use crate::session_claims::{Assurance, HostSessionClaims};
use step_up::{fresh_step_up, StepUpRefusal, STEP_UP_MAX_AGE_SECS, STEP_UP_REQUIRED};

const PRESETS: &str = "/api/v1/agent-hooks/presets";
const NEW_POLICY: &[u8] = br#"{"version":1,"unlisted_tools":"allow"}"#;

/// How a test bends a session's claims.
type Shape = fn(&mut HostSessionClaims);

async fn put(app: &Router, caller: &HeaderMap) -> Reply {
    let headers = with(caller.clone(), "if-match", "\"0\"");
    send(app, &headers, "PUT", POLICY, NEW_POLICY.to_vec()).await
}

/// Nothing was stored and no change event left for the backup actor.
async fn assert_unchanged(st: &AppState) {
    assert_eq!(
        st.db
            .agent_hook_policy(&st.connection_organization.to_string())
            .await
            .unwrap(),
        None
    );
    assert_eq!(st.db.count_unpublished_outbox().await.unwrap(), 0);
}

fn refused_for(reply: &Reply, reason: &str) {
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{}", reply.body);
    assert_eq!(reply.body["error"], STEP_UP_REQUIRED, "{}", reply.body);
    assert_eq!(reply.body["reason"], reason, "{}", reply.body);
    let hint = reply.body["hint"].as_str().unwrap_or_default();
    // The remedy is named: the operator token, or a passkey step-up.
    assert!(hint.contains("operator token"), "{hint}");
    assert!(hint.contains("passkey"), "{hint}");
    assert!(hint.contains("replace the agent-hooks policy"), "{hint}");
}

#[tokio::test]
async fn the_operator_replaces_the_policy_without_a_session() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let reply = put(&app, &operator(&st)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["version"], 1);
    assert_eq!(reply.body["updated_by"], "operator");
}

#[tokio::test]
async fn an_admin_or_owner_on_a_plain_native_session_is_asked_to_step_up() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    for (subject, role) in [
        (P27, OrganizationRole::Admin),
        (P28, OrganizationRole::Owner),
    ] {
        // The CLI's own native session: role enough for everything else here.
        let plain = test_session_headers(&st, subject, st.connection_organization, role);
        let read = send(&app, &plain, "GET", POLICY, Vec::new()).await;
        assert_eq!(read.status, StatusCode::OK, "reading needs no step-up");
        refused_for(&put(&app, &plain).await, "no_step_up");
    }
    assert_unchanged(&st).await;
}

#[tokio::test]
async fn a_fresh_passkey_step_up_on_a_human_session_replaces_the_policy() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let admin = stepped_up(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Admin,
    );
    let reply = put(&app, &admin).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["updated_by"], P27);
}

#[tokio::test]
async fn a_step_up_older_than_five_minutes_is_stale() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let org = st.connection_organization;
    let edge = STEP_UP_MAX_AGE_SECS + 5;
    let stale = session_shaped(&st, P27, org, OrganizationRole::Admin, |claims| {
        step_up_taken(claims, edge);
    });
    refused_for(&put(&app, &stale).await, "stale_step_up");
    // Just inside the window still counts.
    let inside = session_shaped(&st, P27, org, OrganizationRole::Admin, |claims| {
        step_up_taken(claims, STEP_UP_MAX_AGE_SECS - 5);
    });
    assert_eq!(put(&app, &inside).await.status, StatusCode::OK);
}

#[tokio::test]
async fn evidence_short_of_a_passkey_step_up_is_not_one() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let org = st.connection_organization;
    let shapes: [(&str, Shape); 4] = [
        ("assurance without a recorded step-up", |claims| {
            claims.assurance = Assurance::PhishingResistant;
            claims.amr = vec!["webauthn".into()];
        }),
        ("mfa assurance is not phishing-resistant", |claims| {
            step_up_taken(claims, 0);
            claims.assurance = Assurance::Mfa;
            claims.last_step_up_at = None;
        }),
        ("a second method beside webauthn", |claims| {
            step_up_taken(claims, 0);
            claims.amr.push("pwd".into());
        }),
        ("a method other than webauthn", |claims| {
            step_up_taken(claims, 0);
            claims.amr = vec!["totp".into()];
        }),
    ];
    for (name, shape) in shapes {
        let session = session_shaped(&st, P27, org, OrganizationRole::Admin, shape);
        let reply = put(&app, &session).await;
        assert_eq!(
            reply.status,
            StatusCode::FORBIDDEN,
            "{name}: {}",
            reply.body
        );
        assert_eq!(reply.body["error"], STEP_UP_REQUIRED, "{name}");
    }
    assert_unchanged(&st).await;
}

#[tokio::test]
async fn a_member_is_refused_by_role_first_even_with_a_step_up() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let member = stepped_up(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let reply = put(&app, &member).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.body["error"], "forbidden", "role is judged first");
    assert_unchanged(&st).await;
}

#[tokio::test]
async fn a_session_carrying_agent_capabilities_never_satisfies_the_step_up() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let org = st.connection_organization;
    // A native session whose ceiling names agent capabilities is something
    // acting for the person, however fresh the evidence on it.
    for extra in ["host.tasks.invoke", "agent:self", "host.sync.write"] {
        let delegated = session_shaped(&st, P27, org, OrganizationRole::Admin, |claims| {
            step_up_taken(claims, 0);
            claims.capability_ceiling.push(extra.into());
        });
        refused_for(&put(&app, &delegated).await, "delegated_credential");
    }
    assert_unchanged(&st).await;
}

#[tokio::test]
async fn an_agent_capability_or_browser_grant_cannot_reach_the_put_even_stepped_up() {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let token = "b".repeat(64);
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
        .insert(opensesame_claims::hash_secret(&token), agent.clone());
    let headers = with(
        with(
            HeaderMap::new(),
            "authorization",
            &format!("Bearer agent-capability:{token}"),
        ),
        "if-match",
        "\"0\"",
    );
    // Through the router the durable-grant guard refuses it first.
    let app = crate::routes::router(st.clone());
    let reply = send(&app, &headers, "PUT", POLICY, NEW_POLICY.to_vec()).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
    // Called past every guard, the handler still refuses it, by kind.
    let direct = put_policy(
        State(st.clone()),
        headers.clone(),
        Body::from(NEW_POLICY.to_vec()),
    )
    .await;
    assert_eq!(direct.status(), StatusCode::FORBIDDEN);
    // And the step-up guard itself calls it delegated, never merely stale.
    assert_eq!(
        fresh_step_up(&agent, chrono::Utc::now()),
        Err(StepUpRefusal::Delegated)
    );
    let mut browser = agent;
    browser.credential_kind = CredentialKind::BrowserGrant;
    assert_eq!(
        fresh_step_up(&browser, chrono::Utc::now()),
        Err(StepUpRefusal::Delegated)
    );
    assert_unchanged(&st).await;
}

#[tokio::test]
async fn presenting_the_operator_header_beside_a_session_does_not_lift_the_session() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let plain = test_session_headers(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Admin,
    );
    // The route judges the session it authenticated; a second credential on
    // the same request is not a way to be judged as another.
    let both = with(plain, "x-opensesame-operator", &st.operator_token);
    refused_for(&put(&app, &both).await, "no_step_up");
    assert_unchanged(&st).await;
}

#[test]
fn the_evidence_check_is_exact_at_its_edges() {
    let at_age = |age: i64| {
        let mut claims = crate::session_claims::fixture(
            crate::session_claims::parse_principal(P27).unwrap(),
            OrganizationId::new(),
            OrganizationRole::Admin,
            "https://host.test",
        );
        step_up_taken(&mut claims, age);
        claims
    };
    // `now` is read after the claims are made, as a handler's is.
    let check = |claims: &HostSessionClaims| fresh_step_up(claims, chrono::Utc::now());
    assert_eq!(check(&at_age(0)), Ok(()));
    assert_eq!(check(&at_age(STEP_UP_MAX_AGE_SECS - 1)), Ok(()));
    assert_eq!(
        check(&at_age(STEP_UP_MAX_AGE_SECS + 2)),
        Err(StepUpRefusal::Stale)
    );
    // A step-up dated after now is not evidence of anything.
    assert_eq!(check(&at_age(-60)), Err(StepUpRefusal::Stale));
    // An empty ceiling is not a plain one.
    let mut none = at_age(0);
    none.capability_ceiling.clear();
    assert_eq!(check(&none), Err(StepUpRefusal::Delegated));
}

#[tokio::test]
async fn presets_are_listed_to_the_operator_and_admins_only() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let none = send(&app, &HeaderMap::new(), "GET", PRESETS, Vec::new()).await;
    assert_eq!(none.status, StatusCode::UNAUTHORIZED);
    let member = test_session_headers(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let refused = send(&app, &member, "GET", PRESETS, Vec::new()).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    for who in [
        operator(&st),
        test_session_headers(
            &st,
            P27,
            st.connection_organization,
            OrganizationRole::Admin,
        ),
    ] {
        let reply = send(&app, &who, "GET", PRESETS, Vec::new()).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        assert_eq!(reply.body["spec"], "agent-hooks/0.1");
        let names: Vec<&str> = reply.body["presets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|preset| preset["name"].as_str())
            .collect();
        assert_eq!(names, ["observe", "rotation-web-login", "strict"]);
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    }
}

#[tokio::test]
async fn a_preset_is_applied_by_the_ordinary_put_and_reads_back_byte_for_byte() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    let listed = send(&app, &operator(&st), "GET", PRESETS, Vec::new()).await;
    let strict = listed.body["presets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["name"] == "strict")
        .unwrap()
        .clone();
    // Without a step-up the preset is no easier to apply than any policy.
    let plain = test_session_headers(
        &st,
        P27,
        st.connection_organization,
        OrganizationRole::Admin,
    );
    let body = strict["policy"].to_string().into_bytes();
    let headers = with(plain, "if-match", "\"0\"");
    let refused = send(&app, &headers, "PUT", POLICY, body.clone()).await;
    assert_eq!(refused.body["error"], STEP_UP_REQUIRED);
    let headers = with(operator(&st), "if-match", "\"0\"");
    let written = send(&app, &headers, "PUT", POLICY, body).await;
    assert_eq!(written.status, StatusCode::OK, "{}", written.body);
    assert_eq!(written.body["policy"], strict["policy"]);
    // The audit's digest is the one the listing publishes.
    let (id, organization, audit): (String, String, String) = sqlx::query_as(
        "SELECT id, organization_id, payload_json FROM outbox_events WHERE event_type = ?",
    )
    .bind(crate::agent_hooks::EVENT_POLICY_UPDATED)
    .fetch_one(st.db.pool())
    .await
    .unwrap();
    let audit =
        opensesame_event_seal::open_in(&organization, "outbox_events.payload_json", &id, &audit)
            .unwrap();
    let audit: Value = serde_json::from_str(&audit).unwrap();
    assert_eq!(audit["policy_sha256"], strict["policy_sha256"]);
}
