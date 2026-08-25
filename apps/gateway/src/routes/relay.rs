//! Relayed execution (ADR 0046): the credential stays with its holder, the
//! delegate's *request* travels, and the holder's runtime executes it.
//!
//! This is the dual-RPC tier: the holder's runtime polls its inbox over HTTP
//! and posts results back. The admission rules live in `opensesame-relay` and
//! run at both fences — submission and result — so the answer to "may this
//! execute?" cannot diverge between the gateway and the holder:
//!
//! - **Submission** refuses unless the delegation is relay-mode, the holder
//!   has a fresh heartbeat (an absent holder is the end of the request, never
//!   a queue), and nothing asks to materialize.
//! - **Result** refuses unless the holder approved this exact request and the
//!   digest it reports executing equals the digest that was approved — PSD2
//!   dynamic linking applied to API calls. Approval of one request can never
//!   authorize a different one.
//!
//! Requests expire quickly; a holder that stops polling strands nothing, it
//! just lets short-lived rows lapse.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use opensesame_authz::assert_no_secret_in_agent_payload;
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

fn holder_online(st: &AppState, holder: &str) -> HolderLiveness {
    let presence = st.relay_presence.lock().unwrap();
    match presence.get(holder) {
        Some(seen) if seen.elapsed().as_secs() <= PRESENCE_FRESH_SECONDS => HolderLiveness::Online,
        _ => HolderLiveness::Offline,
    }
}

/// The digest an approval binds to: what would run, canonically, nothing else.
fn request_digest(
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
        h.update((part.len() as u32).to_be_bytes());
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

/// `POST /api/v1/relay/requests` — the delegate submits a frozen request.
pub async fn submit(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SubmitRequest>,
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
    let organization = match &caller {
        Caller::Session {
            organization_id, ..
        } => *organization_id,
        Caller::Operator => match st.bootstrap.lock().unwrap().as_ref().map(|b| b.org) {
            Some(org) => org,
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"bootstrap_unavailable"})),
                )
                    .into_response()
            }
        },
    };
    let mine = match st
        .connection_broker
        .list_delegations_for(&organization, &subject)
        .await
    {
        Ok(list) => list,
        Err(_) => {
            return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
        }
    };
    let Some(view) = mine
        .iter()
        .find(|d| d.id == body.delegation_id && d.claimant_subject == subject)
    else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    let resolved = match st
        .connection_broker
        .find_live_delegation(&subject, &view.connection_id)
        .await
    {
        Ok(Some(resolved)) if resolved.delegation_id == body.delegation_id => resolved,
        _ => return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
    };

    // The action must be inside the child grant before anything is parked in
    // front of the holder: an inbox is not a place to launder wider asks.
    if !resolved.grant.actions.iter().any(|a| a == &body.operation) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"action_not_granted"})),
        )
            .into_response();
    }
    if !resolved.grant.permits_resource(&body.resource) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"resource_not_granted"})),
        )
            .into_response();
    }

    let parameters = body.parameters.unwrap_or_else(|| json!({}));
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
    let admission = RelayAdmission {
        mode: resolved.execution_mode,
        liveness: holder_online(&st, &resolved.owner_subject),
        class: AvailabilityClass::A3ExternalSideEffect,
        offline_use: resolved.grant.constraints.offline_use.clone(),
        approved_digest: &digest,
        executing_digest: &digest,
        approval_required: false,
        approved: false,
        materialize: false,
    };
    if let Err(refusal) = admit(&admission) {
        return relay_error(refusal);
    }

    let id = format!("rreq_{}", uuid::Uuid::now_v7().simple());
    let now = Utc::now();
    let insert = sqlx::query(
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
    .bind(&subject)
    .bind(&body.operation)
    .bind(&body.resource)
    .bind(parameters.to_string())
    .bind(&digest)
    .bind((now + Duration::seconds(REQUEST_TTL_SECONDS)).to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(st.connection_broker.pool())
    .await;
    if insert.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"relay_unavailable"})),
        )
            .into_response();
    }
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

fn expired(row_expires: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(row_expires)
        .map(|t| now >= t.with_timezone(&Utc))
        .unwrap_or(true)
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
    let rows = sqlx::query(
        "SELECT id, delegation_id, connection_id, operation, resource, parameters_json,
                request_digest, state, expires_at
         FROM relay_requests
         WHERE holder_subject = ? AND state IN ('pending_approval', 'approved')
         ORDER BY created_at ASC LIMIT 20",
    )
    .bind(&subject)
    .fetch_all(st.connection_broker.pool())
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"relay_unavailable"})),
            )
                .into_response()
        }
    };
    let now = Utc::now();
    let requests: Vec<Value> = rows
        .iter()
        .filter(|row| !expired(&row.get::<String, _>("expires_at"), now))
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "delegation_id": row.get::<String, _>("delegation_id"),
                "connection_id": row.get::<String, _>("connection_id"),
                "operation": row.get::<String, _>("operation"),
                "resource": row.get::<String, _>("resource"),
                "parameters": serde_json::from_str::<Value>(&row.get::<String, _>("parameters_json"))
                    .unwrap_or(json!({})),
                "request_digest": row.get::<String, _>("request_digest"),
                "state": row.get::<String, _>("state"),
            })
        })
        .collect();
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
    let now = Utc::now();
    let next = if approve { "approved" } else { "denied" };
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = ?, approved_at = ?, decided_by = ?
         WHERE id = ? AND holder_subject = ? AND state = 'pending_approval'
           AND request_digest = ? AND expires_at > ?",
    )
    .bind(next)
    .bind(now.to_rfc3339())
    .bind(&subject)
    .bind(id)
    .bind(&subject)
    .bind(&body.request_digest)
    .bind(now.to_rfc3339())
    .execute(st.connection_broker.pool())
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"id": id, "state": next})).into_response()
        }
        // Wrong digest, wrong holder, lapsed, or already decided: one answer,
        // so none of those is distinguishable from outside.
        _ => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
    }
}

/// `POST /api/v1/relay/requests/{id}/approve` — the holder consents.
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
    /// The digest of what the holder's runtime actually executed.
    executed_digest: String,
    outcome: String,
    #[serde(default)]
    safe_summary: Option<Value>,
}

/// `POST /api/v1/relay/requests/{id}/result` — the holder reports back.
///
/// The full admission runs here, at the execution boundary: the request must
/// have been approved, and the executed digest must equal the approved one.
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
    let row = sqlx::query(
        "SELECT delegation_id, holder_subject, delegate_subject, request_digest, state, expires_at
         FROM relay_requests WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(st.connection_broker.pool())
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    if row.get::<String, _>("holder_subject") != subject {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    }
    let state: String = row.get("state");
    if expired(&row.get::<String, _>("expires_at"), Utc::now()) {
        return (StatusCode::GONE, Json(json!({"error":"expired"}))).into_response();
    }

    // The delegation may have been revoked or narrowed since approval; the
    // stored digest pins the request, but authority is re-read live.
    let delegation_id: String = row.get("delegation_id");
    let delegate: String = row.get("delegate_subject");
    let live = st
        .connection_broker
        .list_delegations_for(
            &match crate::middleware::auth::resolve_caller(&st, &headers) {
                Ok(Caller::Session {
                    organization_id, ..
                }) => organization_id,
                _ => match st.bootstrap.lock().unwrap().as_ref().map(|b| b.org) {
                    Some(org) => org,
                    None => {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error":"bootstrap_unavailable"})),
                        )
                            .into_response()
                    }
                },
            },
            &delegate,
        )
        .await
        .ok()
        .and_then(|list| {
            list.into_iter()
                .find(|d| d.id == delegation_id && d.revoked_at.is_none())
        });
    let mode = live
        .as_ref()
        .map(|d| d.execution_mode)
        .unwrap_or(ExecutionMode::Broker);

    let approved_digest: String = row.get("request_digest");
    let admission = RelayAdmission {
        mode,
        // The holder is reporting a result; it is by definition reachable.
        liveness: HolderLiveness::Online,
        class: AvailabilityClass::A3ExternalSideEffect,
        offline_use: opensesame_domain::OfflineUse::Forbidden,
        approved_digest: &approved_digest,
        executing_digest: &body.executed_digest,
        approval_required: true,
        approved: state == "approved",
        materialize: false,
    };
    if let Err(refusal) = admit(&admission) {
        return relay_error(refusal);
    }

    // The summary is holder-authored and lands where the delegate reads it:
    // hostile-input rules apply in both directions.
    let summary = body.safe_summary.unwrap_or(json!({}));
    if assert_no_secret_in_agent_payload(&summary).is_err() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"summary_rejected"})),
        )
            .into_response();
    }
    let outcome = if body.outcome == "succeeded" {
        "succeeded"
    } else {
        "failed"
    };
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = 'completed', result_json = ?, result_outcome = ?, completed_at = ?
         WHERE id = ? AND state = 'approved'",
    )
    .bind(summary.to_string())
    .bind(outcome)
    .bind(Utc::now().to_rfc3339())
    .bind(&id)
    .execute(st.connection_broker.pool())
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"id": id, "state": "completed", "outcome": outcome})).into_response()
        }
        _ => (StatusCode::CONFLICT, Json(json!({"error":"conflict"}))).into_response(),
    }
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
mod tests {
    use super::*;
    use axum::extract::State;
    use opensesame_connection_broker::delegation::{
        ClaimOfferRequest, MintOfferRequest, OfferItemSpec,
    };
    use opensesame_connection_broker::model::ConnectionStatus;
    use opensesame_connection_broker::store as broker_store;
    use opensesame_domain::{ConnectionId, EgressBinding, OrganizationId, OrganizationRole};

    const OWNER: &str = "user:holder";
    const GUEST: &str = "user:delegate";

    async fn relay_delegation(
        state: &crate::app_state::AppState,
        org: OrganizationId,
        mode: ExecutionMode,
    ) -> String {
        let now = Utc::now();
        let row = broker_store::ConnectionRow {
            id: ConnectionId::new().to_string(),
            organization_id: org.to_string(),
            project_id: None,
            provider_id: "github".into(),
            integration_id: "deployment:github".into(),
            logical_name: format!("github-{}", uuid::Uuid::now_v7().simple()),
            display_name: "Holder's GitHub".into(),
            status: ConnectionStatus::Active,
            status_detail: None,
            requested_scopes: vec![],
            granted_scopes: vec![],
            account_label: None,
            owner_kind: "user".into(),
            owner_subject: Some(OWNER.into()),
            shareability: "delegable".into(),
            max_invoke_level: 2,
            materialization: "deny".into(),
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec!["api.github.com".into()],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
            created_at: now,
            updated_at: now,
        };
        broker_store::insert_connection(state.connection_broker.pool(), &row)
            .await
            .expect("insert connection");
        let minted = state
            .connection_broker
            .mint_delegation_offer(
                &org,
                OWNER,
                MintOfferRequest {
                    items: vec![OfferItemSpec {
                        connection_id: row.id.clone(),
                        actions: Some(vec!["repository.read".into()]),
                        resources: None,
                        expires_in_seconds: None,
                        budgets: None,
                        execution_mode: mode,
                        required: true,
                        dependencies: vec![],
                    }],
                    ttl_seconds: None,
                },
                &state.claim_pepper,
            )
            .await
            .expect("mint");
        let manifest = state
            .connection_broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = state
            .connection_broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                &state.claim_pepper,
            )
            .await
            .expect("claim");
        delegations[0].id.clone()
    }

    async fn body_json(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    fn submit_body(delegation_id: &str) -> SubmitRequest {
        SubmitRequest {
            delegation_id: delegation_id.into(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            parameters: Some(json!({})),
        }
    }

    #[tokio::test]
    async fn contract_the_full_relay_round_trip_is_digest_bound() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
        let holder =
            crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
        let delegate =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);

        // An offline holder is the end of the request, not a queue.
        let refused = submit(
            State(state.clone()),
            delegate.clone(),
            Json(submit_body(&delegation_id)),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(refused).await["error"], json!("holder_offline"));

        // The holder announces itself; now the request parks in its inbox.
        heartbeat(State(state.clone()), holder.clone()).await;
        let accepted = submit(
            State(state.clone()),
            delegate.clone(),
            Json(submit_body(&delegation_id)),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
        let accepted = body_json(accepted).await;
        let id = accepted["id"].as_str().expect("id").to_string();
        let digest = accepted["request_digest"]
            .as_str()
            .expect("digest")
            .to_string();

        let inbox = body_json(pending(State(state.clone()), holder.clone()).await).await;
        assert_eq!(inbox["requests"][0]["id"], json!(id.clone()));

        // Reporting a result before approval is refused: approval is the gate.
        let early = result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: digest.clone(),
                outcome: "succeeded".into(),
                safe_summary: None,
            }),
        )
        .await;
        assert_eq!(early.status(), StatusCode::FORBIDDEN);

        // Approval binds to bytes: a wrong digest echo approves nothing.
        let wrong = approve(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(DecideRequest {
                request_digest: "sha256:0000".into(),
            }),
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
        let approved = approve(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(DecideRequest {
                request_digest: digest.clone(),
            }),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);

        // Executing something other than what was approved is refused.
        let drifted = result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: "sha256:1111".into(),
                outcome: "succeeded".into(),
                safe_summary: None,
            }),
        )
        .await;
        assert_eq!(drifted.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(drifted).await["error"], json!("digest_mismatch"));

        // A summary that smells like credential material never lands.
        let leaking = result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: digest.clone(),
                outcome: "succeeded".into(),
                safe_summary: Some(json!({"note": "token ghp_PLANTED"})),
            }),
        )
        .await;
        assert_eq!(leaking.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let done = result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: digest.clone(),
                outcome: "succeeded".into(),
                safe_summary: Some(json!({"resource": "repo:acme/catalog"})),
            }),
        )
        .await;
        assert_eq!(done.status(), StatusCode::OK);

        // The delegate reads the outcome; a stranger reads nothing.
        let seen = get(State(state.clone()), delegate.clone(), Path(id.clone())).await;
        assert_eq!(seen.status(), StatusCode::OK);
        assert_eq!(body_json(seen).await["outcome"], json!("succeeded"));
        let stranger = crate::app_state::test_session_headers(
            &state,
            "user:stranger",
            org,
            OrganizationRole::Member,
        );
        let hidden = get(State(state.clone()), stranger, Path(id)).await;
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn adversarial_a_broker_delegation_does_not_open_the_relay() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let delegation_id = relay_delegation(&state, org, ExecutionMode::Broker).await;
        let holder =
            crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
        let delegate =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        heartbeat(State(state.clone()), holder).await;
        let refused = submit(
            State(state.clone()),
            delegate,
            Json(submit_body(&delegation_id)),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(refused).await["error"], json!("not_relay_mode"));
    }

    #[tokio::test]
    async fn adversarial_a_relayed_ask_outside_the_grant_never_reaches_the_inbox() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
        let holder =
            crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
        let delegate =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        heartbeat(State(state.clone()), holder.clone()).await;
        // An inbox is not a place to launder wider asks: the fence runs at
        // submit, before a human ever sees a prompt to mis-approve.
        let mut wider = submit_body(&delegation_id);
        wider.operation = "contents.write".into();
        let refused = submit(State(state.clone()), delegate, Json(wider)).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let inbox = body_json(pending(State(state.clone()), holder).await).await;
        assert_eq!(inbox["requests"], json!([]));
    }
}
