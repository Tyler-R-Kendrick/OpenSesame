//! A stand-in for the Identity API's interaction routes, on loopback, for the
//! tests that drive a hooked run through the real approver (ADR 0159).
//!
//! It answers the four routes the approver speaks with the shapes
//! `packages/control-plane` answers them with, computes the request digest it
//! reports exactly as the Identity plane does (`interaction::digest`, held to
//! `spec/conformance` by its own tests), and records what it was asked. What a
//! person does is a [`Mode`] the test sets while the run is held.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use opensesame_agent_hooks::interaction::digest::{request_digest, RequestFields};
use serde_json::{json, Value};

pub(super) const REF: &str = "ixn_aWQtMQ.tag-1";
const SUBJECT_ID: &str = "areq_1";
const REQUESTER_REF: &str = "req_abcdefghijklmnopqrstuvwx";
const BINDING_MESSAGE: &str = "pre_tool_call on navigate";
const EXPIRES_AT: &str = "2099-01-01T00:05:00.000Z";

/// What the person asked has done so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    /// Nobody has answered (`401 approval_required`).
    Pending,
    /// The person approved: the consume spends and answers `200`.
    Approve,
    /// The person refused (`403 approval_denied`).
    Decline,
}

/// What the mock saw.
#[derive(Default, Debug)]
pub(super) struct Seen {
    pub auth_requests: Vec<Value>,
    pub interactions: Vec<Value>,
    pub consumes: usize,
    pub spends: usize,
    pub revokes: usize,
    pub cancels: Vec<String>,
    pub bearers: Vec<String>,
}

#[derive(Clone)]
struct Mock {
    seen: Arc<Mutex<Seen>>,
    mode: Arc<Mutex<Mode>>,
    base: String,
    /// The server reports (and later attests) a digest over other content:
    /// an approval that is bound to a request nobody asked.
    other_content: bool,
    digests: Arc<Mutex<HashMap<String, String>>>,
}

/// A running mock.
pub(super) struct IdentityMock {
    pub base: String,
    pub seen: Arc<Mutex<Seen>>,
    mode: Arc<Mutex<Mode>>,
}

impl IdentityMock {
    pub(super) fn set(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    /// Wait (bounded) until what the mock has seen satisfies `ready`.
    pub(super) async fn until(&self, ready: impl Fn(&Seen) -> bool) {
        for _ in 0..2000 {
            if ready(&self.seen.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("the identity mock never saw what the test waited for");
    }
}

pub(super) async fn serve(mode: Mode, other_content: bool) -> IdentityMock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mode = Arc::new(Mutex::new(mode));
    let mock = Mock {
        seen: seen.clone(),
        mode: mode.clone(),
        base: base.clone(),
        other_content,
        digests: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/v1/authorization-requests", post(auth_request))
        .route("/v1/authorization-requests/{id}/cancel", post(cancel))
        .route("/v1/interactions", post(interaction))
        .route("/v1/interactions/{reference}/consume", post(consume))
        .route("/v1/interactions/{reference}/revoke", post(revoke))
        .with_state(mock);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    IdentityMock { base, seen, mode }
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
        "authReqId": SUBJECT_ID, "status": "pending",
        "bindingMessage": BINDING_MESSAGE, "requestDigest": "v1:auth-request-digest",
        "requesterRef": REQUESTER_REF, "authorizationDetails": details,
        "expiresAt": EXPIRES_AT, "intervalSeconds": 5
    });
    (StatusCode::CREATED, Json(reply)).into_response()
}

fn digest_over(mock: &Mock, approver_ref: &str, details: &[Value]) -> String {
    let mut hashed = details.to_vec();
    if mock.other_content {
        hashed.push(json!({"type": "something_else"}));
    }
    request_digest(&RequestFields {
        kind: "authorization_request",
        subject: &format!("authorization_request:{SUBJECT_ID}"),
        approver_ref,
        requester_ref: REQUESTER_REF,
        authorization_details: &hashed,
        binding_message: BINDING_MESSAGE,
        resource_ref: None,
        expires_at: EXPIRES_AT,
    })
    .expect("the details are canonical")
}

async fn interaction(
    State(mock): State<Mock>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().interactions.push(body.clone());
    let details: Vec<Value> = body["authorizationDetails"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let digest = digest_over(
        &mock,
        body["approverRef"].as_str().unwrap_or_default(),
        &details,
    );
    mock.digests
        .lock()
        .unwrap()
        .insert(REF.into(), digest.clone());
    let reply = json!({
        "ref": REF, "url": format!("{}/i/{REF}", mock.base), "requestDigest": digest,
        "bindingMessage": BINDING_MESSAGE, "expiresAt": EXPIRES_AT, "status": "pending"
    });
    (StatusCode::CREATED, Json(reply)).into_response()
}

fn error(status: u16, code: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap();
    (status, Json(json!({"error": code}))).into_response()
}

async fn consume(
    State(mock): State<Mock>,
    Path(_reference): Path<String>,
    headers: HeaderMap,
) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().consumes += 1;
    let mode = *mock.mode.lock().unwrap();
    match mode {
        Mode::Pending => error(401, "approval_required"),
        Mode::Decline => error(403, "approval_denied"),
        Mode::Approve => {
            let mut seen = mock.seen.lock().unwrap();
            seen.spends += 1;
            let sent = seen.interactions[0]["authorizationDetails"].clone();
            drop(seen);
            let digest = mock.digests.lock().unwrap().get(REF).cloned();
            let detail = json!({
                "kind": "authorization_request", "status": "consumed",
                "expiresAt": EXPIRES_AT, "requiresApprover": true, "id": "ixn-row-1",
                "requesterRef": REQUESTER_REF, "bindingMessage": BINDING_MESSAGE,
                "requestDigest": digest, "authorizationDetails": sent,
                "createdAt": "2099-01-01T00:00:00.000Z", "decidedAt": "2099-01-01T00:01:00.000Z"
            });
            (StatusCode::OK, Json(detail)).into_response()
        }
    }
}

async fn revoke(State(mock): State<Mock>, headers: HeaderMap) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().revokes += 1;
    (StatusCode::OK, Json(json!({"status": "revoked"}))).into_response()
}

async fn cancel(State(mock): State<Mock>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().cancels.push(id);
    (StatusCode::OK, Json(json!({"status": "cancelled"}))).into_response()
}
