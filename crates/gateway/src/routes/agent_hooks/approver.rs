//! Who an organization's escalated agent actions are put to (ADR 0159):
//! `GET|PUT /api/v1/agent-hooks/approver`.
//!
//! The policy says whether an action needs a person; this says which one. It
//! is stored beside the policy, not inside it (`agent_hook_approvers`), with
//! its own compare-and-set `version` as the `ETag` and its audit event
//! committed with the row.
//!
//! Reading it is the policy's gate (owner/admin or the operator, a native
//! session, never an agent or a browser grant). Replacing it also takes the
//! policy's **step-up** ([`super::step_up`]): choosing who may lift a refusal
//! decides what an agent may do without the operator, and the loop it governs
//! may run under an administrator's own token.
//!
//! The answer says who is asked in one of three words and never repeats the
//! operator's default handle: `organization` (this row's), `operator_default`
//! (the deployment's, because no row names one), or `nobody` (every
//! escalation is denied). `transport_configured` says whether the deployment
//! has an Identity API and a requester bearer at all; without them no handle
//! is ever asked, whatever it says.

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::OrganizationId;
use opensesame_storage::agent_hook_policy::approver::{
    AgentHookApproverAudit, AgentHookApproverWrite, AgentHookApproverWriteOutcome,
    StoredAgentHookApprover,
};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use super::{bounded, error, expected_version, internal, policy_caller, step_up};
use crate::agent_hook_approver::{valid_approver_ref, EVENT_APPROVER_UPDATED};
use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller_organization, Caller};

/// Largest approver document a `PUT` reads: one handle.
const MAX_APPROVER_BYTES: usize = 4 * 1024;

struct ApproverBody {
    /// The handle, or `None` (JSON `null`) to ask nobody. The member is
    /// required: an absent one is a mistake, never a clear.
    approver_ref: Option<String>,
}

fn who_is_asked(state: &AppState, stored: Option<&StoredAgentHookApprover>) -> &'static str {
    // A row decides, even a row that clears the handle; only no row at all
    // falls through to the operator's default.
    let default = || {
        state
            .agent_hook_approver
            .as_ref()
            .is_some_and(|settings| settings.default_ref().is_some())
    };
    match stored {
        Some(row) if row.approver_ref.is_some() => "organization",
        None if default() => "operator_default",
        _ => "nobody",
    }
}

fn approver_response(state: &AppState, stored: Option<&StoredAgentHookApprover>) -> Response {
    let body = json!({
        "version": stored.map_or(0, |row| row.version),
        "stored": stored.is_some(),
        "approver_ref": stored.and_then(|row| row.approver_ref.as_deref()),
        "asks": who_is_asked(state, stored),
        "transport_configured": state.agent_hook_approver.is_some(),
        "updated_at": stored.map(|row| row.updated_at.as_str()),
        "updated_by": stored.map(|row| row.updated_by.as_str()),
    });
    let mut response = Json(body).into_response();
    let headers = response.headers_mut();
    let version = stored.map_or(0, |row| row.version);
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{version}\"")) {
        headers.insert(header::ETAG, etag);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `GET /api/v1/agent-hooks/approver`.
pub async fn get_approver(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let who = match policy_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .agent_hook_approver(&organization_id.to_string())
        .await
    {
        Ok(stored) => approver_response(&st, stored.as_ref()),
        Err(failure) => internal("load agent-hooks approver", &failure),
    }
}

async fn parsed_body(headers: &HeaderMap, body: Body) -> Result<ApproverBody, Response> {
    let bytes = bounded(headers, body, MAX_APPROVER_BYTES)
        .await
        .map_err(|oversized| {
            if oversized {
                error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "an agent-hooks approver is one inbox handle",
                )
            } else {
                error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "the body could not be read",
                )
            }
        })?;
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_approver",
            "the body is {\"approver_ref\": \"inbox_…\"} or {\"approver_ref\": null}",
        )
    };
    let approver_ref = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(members)) if members.len() == 1 => match members.get("approver_ref") {
            Some(Value::Null) => None,
            Some(Value::String(handle)) => Some(handle.clone()),
            _ => return Err(invalid()),
        },
        _ => return Err(invalid()),
    };
    let parsed = ApproverBody { approver_ref };
    if parsed
        .approver_ref
        .as_deref()
        .is_some_and(|handle| !valid_approver_ref(handle))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_approver",
            "approver_ref is the approver's inbox handle (inbox_…, from their GET /v1/authorization-requests/inbox-ref)",
        ));
    }
    Ok(parsed)
}

fn update_audit(
    organization_id: &OrganizationId,
    who: &Caller,
    expected: i64,
    approver_ref: Option<&str>,
) -> Value {
    json!({
        "organization_id": organization_id.to_string(),
        "updated_by": who.actor_subject(),
        "previous_version": expected,
        "version": expected.saturating_add(1),
        // The handle names somebody's inbox; the audit keeps its digest.
        "approver_sha256": approver_ref.map(|handle| hex::encode(Sha256::digest(handle.as_bytes()))),
    })
}

/// `PUT /api/v1/agent-hooks/approver` — compare-and-set replacement.
pub async fn put_approver(State(st): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let who = match policy_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    if let Err(response) = step_up::require_step_up(
        &st,
        &headers,
        &who,
        "change who approves the agent-hooks escalations",
    ) {
        return response;
    }
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let expected = match expected_version(&headers) {
        Ok(version) => version,
        Err(response) => return response,
    };
    let parsed = match parsed_body(&headers, body).await {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let approver_ref = parsed.approver_ref.as_deref();
    let organization = organization_id.to_string();
    let audit = update_audit(&organization_id, &who, expected, approver_ref).to_string();
    let write = AgentHookApproverWrite {
        organization_id: &organization,
        approver_ref,
        expected_version: expected,
        updated_by: who.actor_subject(),
    };
    let audit = AgentHookApproverAudit {
        event_type: EVENT_APPROVER_UPDATED,
        payload_json: &audit,
    };
    match st.db.put_agent_hook_approver(&write, &audit).await {
        Ok(AgentHookApproverWriteOutcome::Written(row)) => approver_response(&st, Some(&row)),
        Ok(AgentHookApproverWriteOutcome::Conflict { current_version }) => (
            StatusCode::PRECONDITION_FAILED,
            Json(json!({
                "error": "precondition_failed",
                "hint": "the approver changed since that version was read; GET it again and reapply",
                "current_version": current_version,
            })),
        )
            .into_response(),
        Err(failure) => internal("store agent-hooks approver", &failure),
    }
}
