use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use crate::test_principals::{P26, P27, P28};
use axum::http::Request;
use opensesame_domain::{OrganizationId, OrganizationRole};
use tower::ServiceExt;

const INTERCEPT: &str = "/api/v1/agent-hooks/intercept";
const POLICY: &str = "/api/v1/agent-hooks/policy";

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn send(app: &Router, headers: &HeaderMap, method: &str, uri: &str, body: Vec<u8>) -> Reply {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    Reply {
        status,
        headers,
        body,
    }
}

fn with(mut headers: HeaderMap, name: &'static str, value: &str) -> HeaderMap {
    headers.insert(name, HeaderValue::from_str(value).unwrap());
    headers
}

fn tool_call(name: &str, args: &Value) -> Vec<u8> {
    json!({
        "spec": "agent-hooks/0.1",
        "interception_point": "pre_tool_call",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "sequence": 4,
        "agent": {"id": "agent-1", "framework": "reference"},
        "session": {"id": "sess-1"},
        "tool_call": {"id": "tc-1", "name": name, "args": args},
        "target": args,
    })
    .to_string()
    .into_bytes()
}

fn output(content: &str) -> Vec<u8> {
    json!({
        "spec": "agent-hooks/0.1",
        "interception_point": "output",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "sequence": 6,
        "agent": {"id": "agent-1", "framework": "reference"},
        "session": {"id": "sess-1"},
        "output": {"content": content},
        "target": {"content": content},
    })
    .to_string()
    .into_bytes()
}

fn operator(st: &AppState) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer operator:{}", st.operator_token)).unwrap(),
    );
    headers
}

/// A native session for `subject` whose claims `shape` has adjusted, as the
/// headers that present it.
fn session_shaped(
    st: &AppState,
    subject: &str,
    organization: OrganizationId,
    role: OrganizationRole,
    shape: impl FnOnce(&mut crate::session_claims::HostSessionClaims),
) -> HeaderMap {
    let token = uuid::Uuid::new_v4().to_string();
    let mut claims = crate::session_claims::fixture(
        crate::session_claims::parse_principal(subject).unwrap(),
        organization,
        role,
        &st.resource,
    );
    shape(&mut claims);
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&token), claims);
    with(
        HeaderMap::new(),
        "authorization",
        &format!("Bearer opaque-session:{token}"),
    )
}

/// Claims that carry a passkey step-up taken `age_secs` ago (ADR 0084's
/// evidence: phishing-resistant, `webauthn`, `last_step_up_at`).
fn step_up_taken(claims: &mut crate::session_claims::HostSessionClaims, age_secs: i64) {
    let at = chrono::Utc::now() - chrono::Duration::seconds(age_secs);
    claims.assurance = crate::session_claims::Assurance::PhishingResistant;
    claims.amr = vec!["webauthn".into()];
    claims.issued_at = at;
    claims.auth_time = at;
    claims.last_step_up_at = Some(at);
    claims.expires_at = chrono::Utc::now() + chrono::Duration::minutes(5);
}

/// A session that has just stepped up: what may replace the policy.
fn stepped_up(
    st: &AppState,
    subject: &str,
    organization: OrganizationId,
    role: OrganizationRole,
) -> HeaderMap {
    session_shaped(st, subject, organization, role, |claims| {
        step_up_taken(claims, 0);
    })
}

/// The audit rows, oldest first, as the JSON the audit has always had.
async fn decision_rows(st: &AppState) -> Vec<Value> {
    use sqlx::Row as _;
    sqlx::query(
        "SELECT organization_id, caller, interception_point, decision, escalated, reason, \
         policy_version FROM agent_hook_decisions ORDER BY id",
    )
    .fetch_all(st.db.pool())
    .await
    .unwrap()
    .iter()
    .map(|row| {
        json!({
            "organization_id": row.get::<String, _>("organization_id"),
            "caller": row.get::<String, _>("caller"),
            "interception_point": row.get::<Option<String>, _>("interception_point"),
            "decision": row.get::<String, _>("decision"),
            "escalated": row.get::<i64, _>("escalated") != 0,
            "reason": row.get::<Option<String>, _>("reason"),
            "policy_version": row.get::<i64, _>("policy_version"),
        })
    })
    .collect()
}

#[tokio::test]
async fn every_route_requires_authentication() {
    let st = test_demo_state().await;
    let app = crate::routes::router(st.clone());
    for (method, uri) in [("POST", INTERCEPT), ("GET", POLICY), ("PUT", POLICY)] {
        let reply = send(
            &app,
            &HeaderMap::new(),
            method,
            uri,
            tool_call("x", &json!({})),
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    assert!(decision_rows(&st).await.is_empty());
}

#[tokio::test]
async fn an_agent_credential_never_reaches_a_verdict_or_the_policy() {
    for (method, path) in [("POST", INTERCEPT), ("GET", POLICY), ("PUT", POLICY)] {
        assert_eq!(
            crate::middleware::agent_grants::capability(method, path),
            None
        );
        assert_eq!(
            crate::middleware::browser_user_routes::required_capability(method, path),
            None
        );
    }
    let st = test_demo_state().await;
    let token = "a".repeat(64);
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
    // In the handler itself, behind the guard.
    let Err(refused) = framework_caller(&st, &headers) else {
        panic!("an agent capability is not the agent framework");
    };
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    // Nor, owner role and all, an administrator of the policy governing it.
    let Err(refused) = policy_caller(&st, &headers) else {
        panic!("an agent capability never reads or writes its own policy");
    };
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    // And at the guard, before dispatch.
    let app = crate::routes::router(st.clone());
    let reply = send(
        &app,
        &headers,
        "POST",
        INTERCEPT,
        tool_call("x", &json!({})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
    assert!(decision_rows(&st).await.is_empty());
}

#[tokio::test]
async fn a_member_gets_verdicts_but_cannot_touch_the_policy() {
    let st = test_demo_state().await;
    let member = test_session_headers(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let app = crate::routes::router(st.clone());
    let reply = send(
        &app,
        &member,
        "POST",
        INTERCEPT,
        tool_call("deploy", &json!({})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    // No stored policy: the default escalates every tool.
    assert_eq!(reply.body["decision"], "deny");
    assert_eq!(reply.body["reason"], "opensesame:tool_requires_approval");
    assert!(reply.body.get("approval").is_some());
    assert_eq!(reply.headers[POLICY_VERSION_HEADER], "0");

    for method in ["GET", "PUT"] {
        let headers = with(member.clone(), "if-match", "\"0\"");
        let reply = send(&app, &headers, method, POLICY, b"{\"version\":1}".to_vec()).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method}");
    }
}

#[tokio::test]
async fn an_unreadable_context_is_answered_with_a_deny_verdict() {
    let st = test_demo_state().await;
    let member = test_session_headers(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let app = crate::routes::router(st.clone());
    let oversized = vec![b' '; MAX_CONTEXT_BYTES + 1];
    let declared = with(
        member.clone(),
        "content-length",
        &oversized.len().to_string(),
    );
    for (headers, body, message) in [
        (&member, oversized.clone(), "exceeds"),
        (&declared, oversized, "exceeds"),
        (&member, vec![0xff, 0xfe, b'{'], "not UTF-8"),
        (
            &member,
            b"{\"interception_point\":\"output\"}".to_vec(),
            "envelope",
        ),
    ] {
        let reply = send(&app, headers, "POST", INTERCEPT, body).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        assert_eq!(reply.body["decision"], "deny");
        assert_eq!(reply.body["reason"], REASON_CONTEXT_UNREADABLE);
        let said = reply.body["message"].as_str().unwrap_or_default();
        assert!(said.contains(message), "{said}");
    }
    let rows = decision_rows(&st).await;
    assert_eq!(rows.len(), 4, "refusals are decisions too");
    assert_eq!(rows[3]["interception_point"], "output");
}

#[tokio::test]
async fn decisions_are_audited_without_content() {
    let st = test_demo_state().await;
    let member = test_session_headers(
        &st,
        P26,
        st.connection_organization,
        OrganizationRole::Member,
    );
    let app = crate::routes::router(st.clone());
    let secret = format!("ghp_{}", "x".repeat(36));

    let redacted = send(
        &app,
        &member,
        "POST",
        INTERCEPT,
        output(&format!("token {secret}")),
    )
    .await;
    assert_eq!(redacted.body["decision"], "transform");
    assert!(!redacted.body.to_string().contains(&secret));
    let args = json!({"token": secret});
    let denied = send(
        &app,
        &member,
        "POST",
        INTERCEPT,
        tool_call("secret_tool_name", &args),
    )
    .await;
    assert_eq!(denied.body["reason"], "opensesame:raw_secret");

    // The audit is its own table: nothing reaches the backup actor's outbox,
    // however much agent traffic there is.
    assert_eq!(st.db.count_unpublished_outbox().await.unwrap(), 0);

    let rows = decision_rows(&st).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["decision"], "transform");
    assert_eq!(rows[0]["reason"], "opensesame:secret_redacted");
    assert_eq!(rows[0]["interception_point"], "output");
    assert_eq!(rows[1]["interception_point"], "pre_tool_call");
    assert_eq!(rows[1]["caller"], P26);
    for row in &rows {
        let text = row.to_string();
        for forbidden in [
            secret.as_str(),
            "secret_tool_name",
            "token",
            "message",
            "transform\":{",
        ] {
            assert!(
                !text.contains(forbidden),
                "audit row carries {forbidden}: {text}"
            );
        }
    }
}

#[path = "agent_hooks_policy_tests.rs"]
mod policy;

#[path = "agent_hooks_decisions_tests.rs"]
mod decisions;

#[path = "agent_hooks_step_up_tests.rs"]
mod step_up_gate;

#[path = "agent_hooks_approver_tests.rs"]
mod approver_gate;
