//! A scripted stand-in for the Identity API's interaction routes, served on
//! loopback. It answers the four routes the approver speaks with the shapes
//! `packages/control-plane` answers them with, and records every request.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use opensesame_agent_hooks::interaction::DEFAULT_POLL_INTERVAL;
use opensesame_agent_hooks::{InteractionApprover, InteractionApproverConfig};
use serde_json::{json, Value};

pub const BEARER: &str = "test-requester-bearer";
pub const APPROVER_REF: &str = "inbox_YXBwcm92ZXI.test-tag";
pub const REF: &str = "ixn_aWQtMQ.tag-1";
pub const DIGEST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
pub const OTHER_DIGEST: &str =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";
/// A server-written string that must never reach a verdict.
pub const SERVER_PROSE: &str = "server-prose-that-must-not-echo";

/// How a consume attempt is answered.
#[derive(Clone, Debug)]
pub enum Step {
    /// `401 approval_required` — unanswered, or declined.
    Pending,
    /// `200` with the consumed detail echoing what was sent.
    Spend,
    /// `200` with a consumed detail altered by the closure.
    SpendAltered(fn(&mut Value)),
    /// Any other status and error code.
    Reply(u16, &'static str),
    /// A redirect to another route on the same server.
    Redirect,
    /// `200` with a body past the approver's read bound.
    Oversized,
    /// Hold the reply this long, then answer `200` with a clean spend.
    Stall(Duration),
}

/// What the mock saw.
#[derive(Default, Debug)]
pub struct Seen {
    pub auth_requests: Vec<Value>,
    pub interactions: Vec<Value>,
    pub consumes: usize,
    pub revokes: usize,
    pub redirected: usize,
    pub bearers: Vec<String>,
}

#[derive(Clone)]
struct Mock {
    seen: Arc<Mutex<Seen>>,
    script: Arc<Mutex<VecDeque<Step>>>,
    create_status: u16,
    base: String,
}

pub struct Server {
    pub base: String,
    pub seen: Arc<Mutex<Seen>>,
}

fn note_bearer(mock: &Mock, headers: &HeaderMap) {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    mock.seen.lock().unwrap().bearers.push(bearer);
}

async fn auth_request(
    State(mock): State<Mock>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    note_bearer(&mock, &headers);
    let details = body["authorizationDetails"].clone();
    mock.seen.lock().unwrap().auth_requests.push(body);
    let reply = json!({
        "authReqId": "areq_1",
        "status": "pending",
        "bindingMessage": "Approve an agent action: pre_tool_call",
        "requestDigest": "v1:auth-request-digest",
        "authorizationDetails": details,
        "expiresAt": "2026-09-28T12:05:00.000Z",
        "intervalSeconds": 5
    });
    (StatusCode::CREATED, Json(reply)).into_response()
}

async fn interaction(
    State(mock): State<Mock>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().interactions.push(body);
    if mock.create_status != 201 {
        let status = StatusCode::from_u16(mock.create_status).unwrap();
        return (status, Json(json!({"error": "interaction_already_live"}))).into_response();
    }
    let reply = json!({
        "ref": REF,
        "url": format!("{}/i/{REF}", mock.base),
        "requestDigest": DIGEST,
        "bindingMessage": "pre_tool_call on deploy",
        "expiresAt": "2026-09-28T12:05:00.000Z",
        "status": "pending"
    });
    (StatusCode::CREATED, Json(reply)).into_response()
}

/// The consumed `InteractionDetail`, as `toDetail` renders it.
fn consumed_detail(mock: &Mock) -> Value {
    let sent = mock.seen.lock().unwrap().interactions[0]["authorizationDetails"].clone();
    json!({
        "kind": "authorization_request",
        "status": "consumed",
        "expiresAt": "2026-09-28T12:05:00.000Z",
        "requiresApprover": true,
        "id": "ixn-row-1",
        "requesterRef": "req_abcdefghijklmnopqrstuvwx",
        "bindingMessage": "pre_tool_call on deploy",
        "requestDigest": DIGEST,
        "authorizationDetails": sent,
        "createdAt": "2026-09-28T12:00:00.000Z",
        "decidedAt": "2026-09-28T12:01:00.000Z"
    })
}

async fn consume(
    State(mock): State<Mock>,
    Path(reference): Path<String>,
    headers: HeaderMap,
) -> Response {
    note_bearer(&mock, &headers);
    assert_eq!(
        reference, REF,
        "the approver consumes the reference it was handed"
    );
    mock.seen.lock().unwrap().consumes += 1;
    let step = {
        let mut script = mock.script.lock().unwrap();
        if script.len() > 1 {
            script.pop_front().unwrap()
        } else {
            script.front().cloned().unwrap_or(Step::Pending)
        }
    };
    match step {
        Step::Pending => error(401, "approval_required"),
        Step::Spend => (StatusCode::OK, Json(consumed_detail(&mock))).into_response(),
        Step::SpendAltered(alter) => {
            let mut detail = consumed_detail(&mock);
            alter(&mut detail);
            (StatusCode::OK, Json(detail)).into_response()
        }
        Step::Reply(status, code) => error(status, code),
        Step::Redirect => (
            StatusCode::FOUND,
            [("location", format!("{}/elsewhere", mock.base))],
        )
            .into_response(),
        Step::Stall(hold) => {
            tokio::time::sleep(hold).await;
            (StatusCode::OK, Json(consumed_detail(&mock))).into_response()
        }
        Step::Oversized => {
            let padding = "x".repeat(opensesame_agent_hooks::interaction::MAX_RESPONSE_BYTES);
            let mut detail = consumed_detail(&mock);
            detail["padding"] = json!(padding);
            (StatusCode::OK, Json(detail)).into_response()
        }
    }
}

fn error(status: u16, code: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap();
    (status, Json(json!({"error": code, "detail": SERVER_PROSE}))).into_response()
}

async fn revoke(State(mock): State<Mock>, headers: HeaderMap) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().revokes += 1;
    (StatusCode::OK, Json(json!({"status": "revoked"}))).into_response()
}

async fn elsewhere(State(mock): State<Mock>) -> Response {
    mock.seen.lock().unwrap().redirected += 1;
    (StatusCode::OK, Json(consumed_detail(&mock))).into_response()
}

/// Serve the mock with `script` for consume and `create_status` for
/// `POST /v1/interactions`.
pub async fn serve(script: Vec<Step>, create_status: u16) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mock = Mock {
        seen: seen.clone(),
        script: Arc::new(Mutex::new(script.into())),
        create_status,
        base: base.clone(),
    };
    let app = Router::new()
        .route("/v1/authorization-requests", post(auth_request))
        .route("/v1/interactions", post(interaction))
        .route("/v1/interactions/{reference}/consume", post(consume))
        .route("/v1/interactions/{reference}/revoke", post(revoke))
        .route("/elsewhere", post(elsewhere).get(elsewhere))
        .with_state(mock);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { base, seen }
}

/// The approver configuration the tests use against `base`.
pub fn config(base: &str, deadline: Duration) -> InteractionApproverConfig {
    InteractionApproverConfig {
        identity_api_url: base.to_owned(),
        bearer: BEARER.to_owned().into(),
        approver_ref: APPROVER_REF.to_owned(),
        ttl: Duration::from_secs(300),
        poll_interval: Duration::from_millis(10).min(DEFAULT_POLL_INTERVAL),
        deadline,
    }
}

pub fn approver(base: &str) -> InteractionApprover {
    InteractionApprover::new(config(base, Duration::from_secs(5))).expect("config is valid")
}
