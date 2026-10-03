//! `GET /api/v1/agent-hooks/decisions`: who may read the audit, what it
//! carries, and how it pages and filters.

use super::*;
use opensesame_storage::agent_hook_policy::decisions::NewAgentHookDecision;

const DECISIONS: &str = "/api/v1/agent-hooks/decisions";

async fn answer(app: &Router, headers: &HeaderMap, body: Vec<u8>) {
    let reply = send(app, headers, "POST", INTERCEPT, body).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
}

fn ids(reply: &Reply) -> Vec<i64> {
    reply.body["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_i64().unwrap())
        .collect()
}

async fn seeded() -> (AppState, Router, HeaderMap) {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let owner = test_session_headers(&st, P27, org, OrganizationRole::Owner);
    let member = test_session_headers(&st, P26, org, OrganizationRole::Member);
    let app = crate::routes::router(st.clone());
    // A tool that escalates, one denied outright by the default guard, a
    // redaction and an allowed output — four decisions, in that order.
    answer(&app, &member, tool_call("deploy", &json!({}))).await;
    answer(
        &app,
        &member,
        tool_call("t", &json!({"k": format!("ghp_{}", "x".repeat(36))})),
    )
    .await;
    answer(
        &app,
        &member,
        output(&format!("token ghp_{}", "x".repeat(36))),
    )
    .await;
    answer(&app, &member, output("all done")).await;
    (st, app, owner)
}

#[tokio::test]
async fn only_an_owner_admin_or_operator_reads_the_audit() {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let app = crate::routes::router(st.clone());
    let reply = send(&app, &HeaderMap::new(), "GET", DECISIONS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    let member = test_session_headers(&st, P26, org, OrganizationRole::Member);
    let reply = send(&app, &member, "GET", DECISIONS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    for role in [OrganizationRole::Owner, OrganizationRole::Admin] {
        let who = test_session_headers(&st, P27, org, role);
        let reply = send(&app, &who, "GET", DECISIONS, Vec::new()).await;
        assert_eq!(reply.status, StatusCode::OK, "{role:?}: {}", reply.body);
        assert_eq!(reply.body["decisions"], json!([]));
        assert_eq!(reply.body["next_cursor"], Value::Null);
        assert_eq!(reply.body["retention_days"], 90);
    }
    let reply = send(&app, &operator(&st), "GET", DECISIONS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
}

#[tokio::test]
async fn an_agent_credential_never_reads_the_trail_of_its_own_verdicts() {
    assert_eq!(
        crate::middleware::agent_grants::capability("GET", DECISIONS),
        None
    );
    assert_eq!(
        crate::middleware::browser_user_routes::required_capability("GET", DECISIONS),
        None
    );
    let st = test_demo_state().await;
    let token = "b".repeat(64);
    let mut claims = crate::session_claims::fixture(
        crate::session_claims::parse_principal(P26).unwrap(),
        st.connection_organization,
        OrganizationRole::Owner,
        &st.resource,
    );
    claims.credential_kind = CredentialKind::AgentCapability;
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&token), claims);
    let headers = with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer agent-capability:{token}"),
    );
    let Err(refused) = policy_caller(&st, &headers) else {
        panic!("an agent capability is not an administrator of the audit");
    };
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let app = crate::routes::router(st.clone());
    let reply = send(&app, &headers, "GET", DECISIONS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
}

#[tokio::test]
async fn the_audit_lists_newest_first_and_carries_no_content() {
    let (_, app, owner) = seeded().await;
    let reply = send(&app, &owner, "GET", DECISIONS, Vec::new()).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let rows = reply.body["decisions"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert!(ids(&reply).windows(2).all(|pair| pair[0] > pair[1]));
    assert_eq!(rows[0]["interception_point"], "output");
    assert_eq!(rows[0]["decision"], "allow");
    assert_eq!(rows[3]["interception_point"], "pre_tool_call");
    assert_eq!(rows[3]["escalated"], true);
    assert_eq!(rows[3]["reason"], "opensesame:tool_requires_approval");
    assert_eq!(rows[3]["caller"], P26);
    assert_eq!(rows[3]["policy_version"], 0);
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");

    let text = reply.body.to_string();
    for forbidden in [
        "ghp_",
        "deploy",
        "\"target\"",
        "\"message\"",
        "\"transform\":",
    ] {
        assert!(
            !text.contains(forbidden),
            "the audit carries {forbidden}: {text}"
        );
    }
    for row in rows {
        let mut keys: Vec<_> = row.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "caller",
                "created_at",
                "decision",
                "escalated",
                "id",
                "interception_point",
                "policy_version",
                "reason"
            ]
        );
    }
}

#[tokio::test]
async fn the_audit_pages_with_a_cursor_that_survives_new_decisions() {
    let (st, app, owner) = seeded().await;
    let first = send(
        &app,
        &owner,
        "GET",
        &format!("{DECISIONS}?limit=3"),
        Vec::new(),
    )
    .await;
    assert_eq!(ids(&first).len(), 3);
    let cursor = first.body["next_cursor"]
        .as_str()
        .expect("a fourth row remains");

    // Another verdict is answered between the pages; the second page is
    // exactly what followed the first, not shifted by it.
    let member = test_session_headers(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    answer(&app, &member, output("hello")).await;
    let second = send(
        &app,
        &owner,
        "GET",
        &format!("{DECISIONS}?limit=3&cursor={cursor}"),
        Vec::new(),
    )
    .await;
    assert_eq!(ids(&second).len(), 1);
    assert!(ids(&second)[0] < *ids(&first).last().unwrap());
    assert_eq!(second.body["next_cursor"], Value::Null);

    // Walking every page yields every decision once.
    let mut seen = Vec::new();
    let mut uri = format!("{DECISIONS}?limit=2");
    loop {
        let page = send(&app, &owner, "GET", &uri, Vec::new()).await;
        seen.extend(ids(&page));
        match page.body["next_cursor"].as_str() {
            Some(next) => uri = format!("{DECISIONS}?limit=2&cursor={next}"),
            None => break,
        }
    }
    assert_eq!(seen.len(), 5);
    let mut unique = seen.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 5);
}

#[tokio::test]
async fn the_audit_filters_by_exact_match_and_by_time() {
    let (st, app, owner) = seeded().await;
    let get = |query: &str| {
        let app = app.clone();
        let owner = owner.clone();
        let uri = format!("{DECISIONS}?{query}");
        async move { send(&app, &owner, "GET", &uri, Vec::new()).await }
    };
    assert_eq!(ids(&get("decision=deny").await).len(), 2);
    assert_eq!(ids(&get("decision=transform").await).len(), 1);
    assert_eq!(ids(&get("escalated=true").await).len(), 1);
    assert_eq!(ids(&get("interception_point=output").await).len(), 2);
    assert_eq!(ids(&get("reason=opensesame:raw_secret").await).len(), 1);
    assert_eq!(ids(&get(&format!("caller={P26}")).await).len(), 4);
    assert!(ids(&get("caller=nobody").await).is_empty());
    assert_eq!(
        ids(&get("policy_version=0&decision=deny&escalated=false").await).len(),
        1
    );
    assert!(ids(&get("policy_version=7").await).is_empty());
    let all = get("since=2000-01-01T00:00:00Z").await;
    assert_eq!(ids(&all).len(), 4);
    assert!(ids(&get("until=2000-01-01T00:00:00Z").await).is_empty());
    assert!(ids(&get("since=2999-01-01T00:00:00%2B00:00").await).is_empty());

    // Another organization's decisions are not this one's to read.
    st.db
        .append_agent_hook_decision(&NewAgentHookDecision {
            organization_id: &opensesame_domain::OrganizationId::new().to_string(),
            caller: "operator",
            interception_point: Some("input"),
            decision: "deny",
            escalated: false,
            reason: None,
            policy_version: 0,
            created_at: &chrono::Utc::now().to_rfc3339(),
        })
        .await
        .unwrap();
    assert_eq!(ids(&get("decision=deny").await).len(), 2);
}

#[tokio::test]
async fn a_malformed_query_is_refused_rather_than_read_as_everything() {
    let (_, app, owner) = seeded().await;
    for query in [
        "limit=0",
        "limit=101",
        "limit=many",
        "cursor=0",
        "cursor=abc",
        "cursor=-4",
        "cursor=1%20OR%201=1",
        "decision=maybe",
        "interception_point=ghp_not_a_point",
        "escalated=perhaps",
        "policy_version=-1",
        "since=yesterday",
        "until=2026-13-45",
        "caller=",
        "reasons=opensesame:tool_denied",
        "page=2",
    ] {
        let reply = send(
            &app,
            &owner,
            "GET",
            &format!("{DECISIONS}?{query}"),
            Vec::new(),
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{query}: {}",
            reply.body
        );
    }
    let long = "x".repeat(257);
    let reply = send(
        &app,
        &owner,
        "GET",
        &format!("{DECISIONS}?reason={long}"),
        Vec::new(),
    )
    .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}
