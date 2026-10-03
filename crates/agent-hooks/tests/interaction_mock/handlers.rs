//! The routes of the scripted Identity API.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use opensesame_agent_hooks::interaction::digest::{request_digest, RequestFields};
use serde_json::{json, Value};

use super::{
    Fault, Seen, Step, BINDING_MESSAGE, EXPIRES_AT, REF, REQUESTER_REF, SERVER_PROSE, SUBJECT_ID,
};

#[derive(Clone)]
pub(super) struct Mock {
    pub(super) seen: Arc<Mutex<Seen>>,
    pub(super) script: Arc<Mutex<VecDeque<Step>>>,
    pub(super) create_status: u16,
    pub(super) base: String,
    pub(super) fault: Fault,
    /// Replies already given, by route and idempotency key.
    pub(super) replayed: Arc<Mutex<HashMap<String, Value>>>,
    /// The digest the server reports for the interaction it created.
    pub(super) digest: Arc<Mutex<String>>,
    /// Whether the one lost reply has been lost already.
    pub(super) lost: Arc<AtomicBool>,
}

fn note_bearer(mock: &Mock, headers: &HeaderMap) {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    mock.seen.lock().unwrap().bearers.push(bearer);
}

/// The `Idempotency-Key` the request carried, recorded on `keys`.
fn note_key(
    mock: &Mock,
    headers: &HeaderMap,
    keys: impl FnOnce(&mut Seen) -> &mut Vec<String>,
) -> Option<String> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    keys(&mut mock.seen.lock().unwrap()).push(key.clone().unwrap_or_default());
    key
}

/// The reply already given to this route and key, if there was one.
fn replay(mock: &Mock, route: &str, key: Option<&String>) -> Option<Response> {
    let key = key?;
    let cached = mock
        .replayed
        .lock()
        .unwrap()
        .get(&format!("{route}:{key}"))
        .cloned()?;
    Some((StatusCode::CREATED, Json(cached)).into_response())
}

fn remember(mock: &Mock, route: &str, key: Option<&String>, reply: &Value) {
    if let Some(key) = key {
        mock.replayed
            .lock()
            .unwrap()
            .insert(format!("{route}:{key}"), reply.clone());
    }
}

/// Apply the fault meant for this create after the server has acted on it.
async fn after_processing(lose: bool, slow: Option<Duration>) {
    if lose {
        std::future::pending::<()>().await;
    }
    if let Some(hold) = slow {
        tokio::time::sleep(hold).await;
    }
}

async fn auth_request(
    State(mock): State<Mock>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    note_bearer(&mock, &headers);
    let key = note_key(&mock, &headers, |seen| &mut seen.subject_keys);
    if let Some(cached) = replay(&mock, "subject", key.as_ref()) {
        return cached;
    }
    let details = body["authorizationDetails"].clone();
    mock.seen.lock().unwrap().auth_requests.push(body);
    let reply = json!({
        "authReqId": SUBJECT_ID,
        "status": "pending",
        "bindingMessage": "Approve an agent action: pre_tool_call",
        "requestDigest": "v1:auth-request-digest",
        "requesterRef": REQUESTER_REF,
        "authorizationDetails": details,
        "expiresAt": EXPIRES_AT,
        "intervalSeconds": 5
    });
    remember(&mock, "subject", key.as_ref(), &reply);
    let lose = matches!(mock.fault, Fault::LoseFirstSubjectReply)
        && !mock.lost.swap(true, Ordering::SeqCst);
    let slow = match mock.fault {
        Fault::SlowSubject(hold) => Some(hold),
        _ => None,
    };
    after_processing(lose, slow).await;
    (StatusCode::CREATED, Json(reply)).into_response()
}

/// The digest the server reports for an interaction over `details`, computed
/// exactly as `crypto/request-digest.ts` computes it.
fn digest_over(mock: &Mock, approver_ref: &str, details: &[Value]) -> String {
    let subject = format!("authorization_request:{SUBJECT_ID}");
    let mut hashed = details.to_vec();
    if matches!(mock.fault, Fault::WrongDigest) {
        hashed.push(json!({"type": "something_else"}));
    }
    request_digest(&RequestFields {
        kind: "authorization_request",
        subject: &subject,
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
    let key = note_key(&mock, &headers, |seen| &mut seen.interaction_keys);
    if let Some(cached) = replay(&mock, "interaction", key.as_ref()) {
        return cached;
    }
    mock.seen.lock().unwrap().interactions.push(body.clone());
    if mock.create_status != 201 {
        let status = StatusCode::from_u16(mock.create_status).unwrap();
        return (status, Json(json!({"error": "interaction_already_live"}))).into_response();
    }
    let details: Vec<Value> = body["authorizationDetails"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let digest = digest_over(
        &mock,
        body["approverRef"].as_str().unwrap_or_default(),
        &details,
    );
    mock.digest.lock().unwrap().clone_from(&digest);
    let reply = json!({
        "ref": REF,
        "url": format!("{}/i/{REF}", mock.base),
        "requestDigest": digest,
        "bindingMessage": BINDING_MESSAGE,
        "expiresAt": EXPIRES_AT,
        "status": "pending"
    });
    remember(&mock, "interaction", key.as_ref(), &reply);
    let lose = matches!(mock.fault, Fault::LoseFirstInteractionReply)
        && !mock.lost.swap(true, Ordering::SeqCst);
    let slow = match mock.fault {
        Fault::SlowInteraction(hold) => Some(hold),
        _ => None,
    };
    after_processing(lose, slow).await;
    (StatusCode::CREATED, Json(reply)).into_response()
}

/// The consumed `InteractionDetail`, as `toDetail` renders it.
fn consumed_detail(mock: &Mock) -> Value {
    let sent = mock.seen.lock().unwrap().interactions[0]["authorizationDetails"].clone();
    json!({
        "kind": "authorization_request",
        "status": "consumed",
        "expiresAt": EXPIRES_AT,
        "requiresApprover": true,
        "id": "ixn-row-1",
        "requesterRef": REQUESTER_REF,
        "bindingMessage": BINDING_MESSAGE,
        "requestDigest": *mock.digest.lock().unwrap(),
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

async fn cancel(State(mock): State<Mock>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    note_bearer(&mock, &headers);
    mock.seen.lock().unwrap().cancels.push(id);
    (StatusCode::OK, Json(json!({"status": "cancelled"}))).into_response()
}

async fn elsewhere(State(mock): State<Mock>) -> Response {
    mock.seen.lock().unwrap().redirected += 1;
    (StatusCode::OK, Json(consumed_detail(&mock))).into_response()
}

pub(super) fn router(mock: Mock) -> Router {
    Router::new()
        .route("/v1/authorization-requests", post(auth_request))
        .route("/v1/authorization-requests/{id}/cancel", post(cancel))
        .route("/v1/interactions", post(interaction))
        .route("/v1/interactions/{reference}/consume", post(consume))
        .route("/v1/interactions/{reference}/revoke", post(revoke))
        .route("/elsewhere", post(elsewhere).get(elsewhere))
        .with_state(mock)
}
