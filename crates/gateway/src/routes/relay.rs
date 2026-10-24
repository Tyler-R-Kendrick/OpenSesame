//! Relayed execution (ADR 0046): the credential stays with its holder, the
//! delegate's *request* travels, and the holder's runtime executes it.
//!
//! The holder polls work for review, then atomically exchanges a pending request
//! for an execution lease at approval. That response is the final pre-execution
//! handoff: execute once before its deadline, never from a cached inbox row.
//! Current delegation, scope and ancestry are checked under the same SQLite
//! write reservation as the state transition. Revocation committed before the
//! handoff wins; a later revocation cannot undo an already in-flight effect.
//! Results prove the acquired lease and reviewed digest and may arrive until
//! the original request TTL, even when the provider took longer than the
//! execution-start window. The gateway cannot enforce an external runtime's
//! clock or stop a malicious credential holder from invoking its own provider.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use opensesame_authz::assert_no_secret_in_agent_payload;
use opensesame_connection_broker::delegation::ResolvedDelegation;
use opensesame_domain::{AvailabilityClass, Intent};
use opensesame_relay::{admit, ExecutionMode, HolderLiveness, RelayAdmission, RelayRefusal};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller_subject, Caller};

/// A heartbeat older than this is an offline holder. Deliberately short: the
/// whole model is "the holder's live runtime is the authority".
const PRESENCE_FRESH_SECONDS: u64 = 30;
/// How long a submitted request may wait for the holder before lapsing.
const REQUEST_TTL_SECONDS: i64 = 120;

fn relay_error(refusal: RelayRefusal) -> Response {
    let (status, code) = match refusal {
        RelayRefusal::NotRelayMode => (StatusCode::CONFLICT, "not_relay_mode"),
        RelayRefusal::HolderOffline => (StatusCode::CONFLICT, "holder_offline"),
        RelayRefusal::DigestMismatch => (StatusCode::CONFLICT, "digest_mismatch"),
        RelayRefusal::ApprovalRequired => (StatusCode::FORBIDDEN, "approval_required"),
        RelayRefusal::MaterializeDenied => (StatusCode::FORBIDDEN, "materialize_denied"),
    };
    (status, Json(json!({"error": code}))).into_response()
}

fn error_response(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not_found")
}

fn bootstrap_organization(st: &AppState) -> Result<opensesame_domain::OrganizationId, Response> {
    st.bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .map(|bootstrap| bootstrap.org)
        .ok_or_else(|| error_response(StatusCode::SERVICE_UNAVAILABLE, "bootstrap_unavailable"))
}

fn caller_organization(
    st: &AppState,
    caller: &Caller,
) -> Result<opensesame_domain::OrganizationId, Response> {
    match caller {
        Caller::Session {
            organization_id, ..
        } => Ok(*organization_id),
        Caller::Operator => bootstrap_organization(st),
    }
}

fn holder_online(st: &AppState, holder: &str) -> HolderLiveness {
    let presence = st.relay_presence.lock().unwrap();
    match presence.get(holder) {
        Some(seen) if seen.elapsed().as_secs() <= PRESENCE_FRESH_SECONDS => HolderLiveness::Online,
        _ => HolderLiveness::Offline,
    }
}

/// The digest an approval binds to: what would run, canonically, nothing else.
pub(super) fn request_digest(
    delegation_id: &str,
    operation: &str,
    resource: &str,
    parameters: &Value,
) -> Result<String, Response> {
    let params_hash = Intent::parameters_hash(parameters).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_parameters"})),
        )
            .into_response()
    })?;
    let mut h = Sha256::new();
    for part in [
        "opensesame:relay-request:v1",
        delegation_id,
        operation,
        resource,
        &params_hash,
    ] {
        let part_len = u32::try_from(part.len())
            .map_err(|_| error_response(StatusCode::BAD_REQUEST, "invalid_parameters"))?;
        h.update(part_len.to_be_bytes());
        h.update(part.as_bytes());
    }
    Ok(format!("sha256:{:x}", h.finalize()))
}

/// `POST /api/v1/relay/heartbeat` — a holder's runtime announcing liveness.
pub async fn heartbeat(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    st.relay_presence
        .lock()
        .unwrap()
        .insert(subject, std::time::Instant::now());
    Json(json!({"ok": true, "fresh_for_seconds": PRESENCE_FRESH_SECONDS})).into_response()
}

#[derive(Deserialize)]
pub struct SubmitRequest {
    delegation_id: String,
    operation: String,
    resource: String,
    #[serde(default)]
    parameters: Option<Value>,
}

async fn resolve_submit_delegation(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    subject: &str,
    delegation_id: &str,
) -> Result<ResolvedDelegation, Response> {
    let mine = st
        .connection_broker
        .list_delegations_for(organization, subject)
        .await
        .map_err(|_| not_found())?;
    let view = mine
        .iter()
        .find(|delegation| delegation.id == delegation_id && delegation.claimant_subject == subject)
        .ok_or_else(not_found)?;
    match st
        .connection_broker
        .find_live_delegation(subject, &view.connection_id)
        .await
    {
        Ok(Some(resolved)) if resolved.delegation_id == delegation_id => Ok(resolved),
        _ => Err(not_found()),
    }
}

fn authorize_relay_request(
    resolved: &ResolvedDelegation,
    body: &SubmitRequest,
) -> Result<(), Response> {
    if !resolved
        .grant
        .actions
        .iter()
        .any(|action| action == &body.operation)
    {
        return Err(error_response(StatusCode::FORBIDDEN, "action_not_granted"));
    }
    if !resolved.grant.permits_resource(&body.resource) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "resource_not_granted",
        ));
    }
    Ok(())
}

fn admit_submission(
    st: &AppState,
    resolved: &ResolvedDelegation,
    digest: &str,
) -> Result<(), Response> {
    let admission = RelayAdmission {
        mode: resolved.execution_mode,
        liveness: holder_online(st, &resolved.owner_subject),
        class: AvailabilityClass::A3ExternalSideEffect,
        offline_use: resolved.grant.constraints.offline_use.clone(),
        approved_digest: digest,
        executing_digest: digest,
        approval_required: false,
        approved: false,
        materialize: false,
    };
    admit(&admission).map_err(relay_error)
}

async fn insert_relay_request(
    st: &AppState,
    body: &SubmitRequest,
    resolved: &ResolvedDelegation,
    organization: opensesame_domain::OrganizationId,
    subject: &str,
    parameters: &Value,
    digest: &str,
) -> Result<String, Response> {
    let id = format!("rreq_{}", uuid::Uuid::now_v7().simple());
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO relay_requests
         (id, delegation_id, connection_id, organization_id, holder_subject, delegate_subject,
          operation, resource, parameters_json, request_digest, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)",
    )
    .bind(&id)
    .bind(&body.delegation_id)
    .bind(&resolved.connection_id)
    .bind(organization.to_string())
    .bind(&resolved.owner_subject)
    .bind(subject)
    .bind(&body.operation)
    .bind(&body.resource)
    .bind(parameters.to_string())
    .bind(digest)
    .bind((now + Duration::seconds(REQUEST_TTL_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(st.connection_broker.pool())
    .await
    .map_err(|_| error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable"))?;
    Ok(id)
}

/// `POST /api/v1/relay/requests` — the delegate submits a frozen request.
pub async fn submit(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(mut body): Json<SubmitRequest>,
) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let caller = match crate::middleware::auth::resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };

    // Materialization never travels a relay, whatever the delegation says.
    let lower = body.operation.to_ascii_lowercase();
    if lower.contains("secret") || lower.contains("credential") {
        return relay_error(RelayRefusal::MaterializeDenied);
    }

    // The delegation must be the caller's own, live, and relay-mode. Lookup by
    // id via the caller's delegation list keeps the id space unenumerable.
    let organization = match caller_organization(&st, &caller) {
        Ok(organization) => organization,
        Err(response) => return response,
    };
    let resolved =
        match resolve_submit_delegation(&st, &organization, &subject, &body.delegation_id).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };

    // The action must be inside the child grant before anything is parked in
    // front of the holder: an inbox is not a place to launder wider asks.
    if let Err(response) = authorize_relay_request(&resolved, &body) {
        return response;
    }

    let parameters = body.parameters.take().unwrap_or_else(|| json!({}));
    let digest = match request_digest(
        &body.delegation_id,
        &body.operation,
        &body.resource,
        &parameters,
    ) {
        Ok(digest) => digest,
        Err(resp) => return resp,
    };

    // Admission, submission fence: mode, liveness, materialize. Approval is
    // deliberately not required *yet* — it is what the holder's decision will
    // add — so it is presented to `admit` as not-required here and strictly
    // required at the result fence.
    if let Err(response) = admit_submission(&st, &resolved, &digest) {
        return response;
    }

    let id = match insert_relay_request(
        &st,
        &body,
        &resolved,
        organization,
        &subject,
        &parameters,
        &digest,
    )
    .await
    {
        Ok(id) => id,
        Err(response) => return response,
    };
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "id": id,
            "state": "pending_approval",
            "request_digest": digest,
            "expires_in": REQUEST_TTL_SECONDS,
        })),
    )
        .into_response()
}

pub(super) fn expired(row_expires: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(row_expires).map_or(true, |time| now >= time.with_timezone(&Utc))
}

/// `GET /api/v1/relay/requests/pending` — the holder drains its inbox.
pub async fn pending(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    // Draining is itself proof of liveness.
    st.relay_presence
        .lock()
        .unwrap()
        .insert(subject.clone(), std::time::Instant::now());
    // Approved work is never redelivered: only the approval response can
    // hand off its single-use execution lease.
    let Ok(mut tx) = st
        .connection_broker
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
    else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
    };
    let rows = sqlx::query(
        "SELECT * FROM relay_requests
         WHERE holder_subject = ? AND state = 'pending_approval'
         ORDER BY created_at ASC LIMIT 20",
    )
    .bind(&subject)
    .fetch_all(&mut *tx)
    .await;
    let Ok(rows) = rows else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
    };
    let mut requests = Vec::new();
    for row in &rows {
        if super::relay_authority::resolve(&mut tx, row, Utc::now())
            .await
            .is_none()
        {
            // Retire invisible work so it cannot starve later authorized rows.
            let next = if expired(&row.get::<String, _>("expires_at"), Utc::now()) {
                "expired"
            } else {
                "failed"
            };
            if sqlx::query(
                "UPDATE relay_requests SET state = ? WHERE id = ? AND state = 'pending_approval'",
            )
            .bind(next)
            .bind(row.get::<String, _>("id"))
            .execute(&mut *tx)
            .await
            .is_err()
            {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
            }
            continue;
        }
        requests.push(json!({
            "id": row.get::<String, _>("id"),
            "delegation_id": row.get::<String, _>("delegation_id"),
            "connection_id": row.get::<String, _>("connection_id"),
            "operation": row.get::<String, _>("operation"),
            "resource": row.get::<String, _>("resource"),
            "parameters": serde_json::from_str::<Value>(&row.get::<String, _>("parameters_json"))
                .expect("authority resolution checked parameters"),
            "request_digest": row.get::<String, _>("request_digest"),
            "state": row.get::<String, _>("state"),
        }));
    }
    if tx.commit().await.is_err() {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
    }

    Json(json!({"requests": requests})).into_response()
}

#[derive(Deserialize)]
pub struct DecideRequest {
    /// Echo of the digest the holder reviewed. Consent binds to bytes.
    request_digest: String,
}

async fn decide(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    id: &str,
    body: DecideRequest,
    approve: bool,
) -> Response {
    let subject = match resolve_caller_subject(st, headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    // Reserve the writer before reading authority: a revoke/narrow committed
    // first is visible; a later one is ordered after this execution handoff.
    let Ok(mut tx) = st
        .connection_broker
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
    else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
    };
    let row = sqlx::query("SELECT * FROM relay_requests WHERE id = ? AND holder_subject = ?")
        .bind(id)
        .bind(&subject)
        .fetch_optional(&mut *tx)
        .await;
    let Ok(Some(row)) = row else {
        return not_found();
    };
    let now = Utc::now();
    if row.get::<String, _>("state") != "pending_approval"
        || row.get::<String, _>("request_digest") != body.request_digest
        || expired(&row.get::<String, _>("expires_at"), now)
    {
        return not_found();
    }
    let mut lease = None;
    let mut deadline = None;
    let mut authority_digest = None;
    if approve {
        let Some(authority) = super::relay_authority::resolve(&mut tx, &row, now).await else {
            return not_found();
        };
        // This is the execution-start deadline. Slow providers may still
        // report until the original request TTL.
        let request_expiry = DateTime::parse_from_rfc3339(&row.get::<String, _>("expires_at"))
            .expect("authority resolution checked expiry")
            .with_timezone(&Utc);
        deadline = Some(
            (Utc::now() + Duration::seconds(5))
                .min(authority.expires_at)
                .min(request_expiry),
        );
        if deadline.is_some_and(|time| Utc::now() >= time) {
            return not_found();
        }
        lease = Some(format!("rlease_{}", uuid::Uuid::new_v4().simple()));
        authority_digest = Some(authority.digest);
    }
    let next = if approve { "approved" } else { "denied" };
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = ?, approved_at = ?, decided_by = ?, execution_lease = ?,
             execution_expires_at = ?, execution_authority_digest = ?
         WHERE id = ? AND state = 'pending_approval'",
    )
    .bind(next)
    .bind(now.to_rfc3339())
    .bind(&subject)
    .bind(&lease)
    .bind(deadline.map(|time| time.to_rfc3339()))
    .bind(&authority_digest)
    .bind(id)
    .execute(&mut *tx)
    .await;
    if !matches!(updated, Ok(result) if result.rows_affected() == 1) || tx.commit().await.is_err() {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable");
    }
    if approve {
        Json(json!({
            "id": id, "state": next, "execution_lease": lease,
            "execute_before": deadline.map(|time| time.to_rfc3339()),
            "authority_digest": authority_digest, "request_digest": body.request_digest,
        }))
        .into_response()
    } else {
        Json(json!({"id": id, "state": next})).into_response()
    }
}

/// `POST /api/v1/relay/requests/{id}/approve` — final execution authorization.
/// Execute once, immediately before `execute_before`, using the returned lease.
/// Consent or a cached inbox row cannot execute; lost leases cannot be recovered.
pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<DecideRequest>,
) -> Response {
    decide(&st, &headers, &id, body, true).await
}

/// `POST /api/v1/relay/requests/{id}/deny` — the holder refuses.
pub async fn deny(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<DecideRequest>,
) -> Response {
    decide(&st, &headers, &id, body, false).await
}

#[derive(Deserialize)]
pub struct ResultRequest {
    /// Required for execution; legacy approvals fail closed.
    #[serde(default)]
    execution_lease: Option<String>,
    /// The digest of what the holder's runtime actually executed.
    executed_digest: String,
    outcome: String,
    #[serde(default)]
    safe_summary: Option<Value>,
}

struct ResultContext {
    approved_digest: String,
    approved: bool,
    execution_lease: Option<String>,
}

async fn load_result_context(
    st: &AppState,
    id: &str,
    holder_subject: &str,
) -> Result<ResultContext, Response> {
    let row = sqlx::query("SELECT * FROM relay_requests WHERE id = ?")
        .bind(id)
        .fetch_optional(st.connection_broker.pool())
        .await;
    let Ok(Some(row)) = row else {
        return Err(not_found());
    };
    if row.get::<String, _>("holder_subject") != holder_subject {
        return Err(not_found());
    }
    if expired(&row.get::<String, _>("expires_at"), Utc::now()) {
        return Err(error_response(StatusCode::GONE, "expired"));
    }
    Ok(ResultContext {
        approved_digest: row.get("request_digest"),
        approved: row.get::<String, _>("state") == "approved",
        execution_lease: row.get("execution_lease"),
    })
}

fn validate_result(context: &ResultContext, body: &ResultRequest) -> Result<Value, Response> {
    if context.execution_lease.is_none() || context.execution_lease != body.execution_lease {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "execution_lease_required",
        ));
    }
    let admission = RelayAdmission {
        mode: ExecutionMode::Relay,
        // The holder is reporting a result; it is by definition reachable.
        liveness: HolderLiveness::Online,
        class: AvailabilityClass::A3ExternalSideEffect,
        offline_use: opensesame_domain::OfflineUse::Forbidden,
        approved_digest: &context.approved_digest,
        executing_digest: &body.executed_digest,
        approval_required: true,
        approved: context.approved,
        materialize: false,
    };
    admit(&admission).map_err(relay_error)?;

    let summary = body.safe_summary.clone().unwrap_or_else(|| json!({}));
    assert_no_secret_in_agent_payload(&summary)
        .map_err(|_| error_response(StatusCode::UNPROCESSABLE_ENTITY, "summary_rejected"))?;
    Ok(summary)
}

async fn complete_result(
    st: &AppState,
    id: &str,
    summary: &Value,
    requested_outcome: &str,
) -> Response {
    let outcome = if requested_outcome == "succeeded" {
        "succeeded"
    } else {
        "failed"
    };
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = 'completed', result_json = ?, result_outcome = ?, completed_at = ?
         WHERE id = ? AND state = 'approved' AND execution_lease IS NOT NULL",
    )
    .bind(summary.to_string())
    .bind(outcome)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(st.connection_broker.pool())
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"id": id, "state": "completed", "outcome": outcome})).into_response()
        }
        _ => error_response(StatusCode::CONFLICT, "conflict"),
    }
}

/// `POST /api/v1/relay/requests/{id}/result` — the holder reports back.
///
/// Reporting is not authorization to execute. The holder must have acquired
/// the one approval lease and started before its deadline. Reporting remains
/// available until the original request expiry, including for in-flight calls.
pub async fn result(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResultRequest>,
) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let context = match load_result_context(&st, &id, &subject).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    // The summary is holder-authored and lands where the delegate reads it:
    // hostile-input rules apply in both directions.
    let summary = match validate_result(&context, &body) {
        Ok(summary) => summary,
        Err(response) => return response,
    };
    complete_result(&st, &id, &summary, &body.outcome).await
}

/// `GET /api/v1/relay/requests/{id}` — delegate or holder polls.
pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let row = sqlx::query(
        "SELECT id, delegation_id, holder_subject, delegate_subject, operation, resource,
                request_digest, state, result_json, result_outcome, expires_at
         FROM relay_requests WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(st.connection_broker.pool())
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    let holder: String = row.get("holder_subject");
    let delegate: String = row.get("delegate_subject");
    if subject != holder && subject != delegate {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    }
    let state: String = row.get("state");
    let state = if state != "completed" && expired(&row.get::<String, _>("expires_at"), Utc::now())
    {
        "expired".to_string()
    } else {
        state
    };
    Json(json!({
        "id": row.get::<String, _>("id"),
        "delegation_id": row.get::<String, _>("delegation_id"),
        "operation": row.get::<String, _>("operation"),
        "resource": row.get::<String, _>("resource"),
        "request_digest": row.get::<String, _>("request_digest"),
        "state": state,
        "outcome": row.get::<Option<String>, _>("result_outcome"),
        "result": row
            .get::<Option<String>, _>("result_json")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
    }))
    .into_response()
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
