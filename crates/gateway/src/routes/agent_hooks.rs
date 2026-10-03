//! agent-hooks/0.1 over the Host API (ADR 0159): a remote interceptor, and
//! the per-organization policy it decides under.
//!
//! - `POST /api/v1/agent-hooks/intercept` — one `AgentContext` in, its
//!   `Verdict` out, under the caller organization's policy. The caller is the
//!   **agent framework**, never the agent: a native session of any role in
//!   the organization, or the operator. An agent-capability bearer and a
//!   browser grant are refused by the guards before dispatch (neither ceiling
//!   maps this path) and again here — the agent is the subject of a verdict,
//!   and a route it could call would let it probe the policy that governs it.
//!   A context the interceptor cannot read — over 5 MiB, not UTF-8, failing
//!   the envelope — is answered 200 with a deny verdict: a verdict endpoint
//!   answers with verdicts. Every decision is recorded value-blind before it
//!   is handed out, and one that cannot be recorded is not handed out.
//! - `GET /api/v1/agent-hooks/decisions` — the value-blind audit of those
//!   verdicts, paginated and filterable ([`decisions`]).
//! - `GET /api/v1/agent-hooks/policy` — the policy with every default filled,
//!   and its version (0 when none is stored), as the `ETag`.
//! - `PUT /api/v1/agent-hooks/policy` — replace it: the body is the policy
//!   document, `If-Match` names the version it was made against. Validated by
//!   the same parser the interceptor uses; its positional errors pass through.
//!   It also takes a **step-up** ([`step_up`]): the operator, or a human
//!   session's fresh passkey evidence. Owner/admin alone is not enough, since
//!   the loop the policy governs may run under that very role.
//! - `GET /api/v1/agent-hooks/presets` — the named policies a replacement may
//!   start from ([`presets`]).
//! - `GET|PUT /api/v1/agent-hooks/approver` — who an escalated action is put
//!   to, beside the policy and not inside it, with its own version and the
//!   same step-up ([`approver`]).
//!
//! The policy is integration configuration: owner/admin or the operator, the
//! same gate as security hooks and breach findings.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_agent_hooks::interceptor::{MAX_CONTEXT_BYTES, REASON_CONTEXT_UNREADABLE};
use opensesame_agent_hooks::sdk::Verdict;
use opensesame_agent_hooks::{HookPolicy, SPEC_VERSION};
use opensesame_domain::OrganizationId;
use opensesame_storage::agent_hook_policy::{
    AgentHookPolicyAudit, AgentHookPolicyWrite, AgentHookPolicyWriteOutcome,
};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use crate::agent_hooks::{
    interception_point, load_policy, not_utf8_verdict, oversized_verdict, record_decision,
    DecisionRecord, LoadedHookPolicy, EVENT_POLICY_UPDATED,
};
use crate::app_state::AppState;
use crate::middleware::auth::{
    require_operator, require_session, resolve_caller_organization, Caller,
};
use crate::session_claims::CredentialKind;

/// Largest policy document a `PUT` reads. Far above any real rule set; a
/// bound on what one request may make the parser walk.
pub(crate) const MAX_POLICY_BYTES: usize = 256 * 1024;

/// Who an escalated action is put to (`GET|PUT …/approver`).
mod approver;

/// The audit of every verdict answered here (`GET …/decisions`).
mod decisions;

/// Named policy presets (`GET …/presets`), one file each under
/// `spec/agent-hooks/presets/`.
pub(crate) mod presets;

/// The step-up a change to the policy takes, exported for any other setting
/// that decides what an agent may do without a person.
pub(crate) mod step_up;

/// The response header naming the policy version a verdict was decided under.
pub(crate) const POLICY_VERSION_HEADER: &str = "opensesame-hook-policy-version";

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/agent-hooks/intercept", post(intercept))
        .route("/api/v1/agent-hooks/decisions", get(decisions::list))
        .route(
            "/api/v1/agent-hooks/policy",
            get(get_policy).put(put_policy),
        )
        .route("/api/v1/agent-hooks/presets", get(presets::list))
        .route(
            "/api/v1/agent-hooks/approver",
            get(approver::get_approver).put(approver::put_approver),
        )
}

fn error(status: StatusCode, error: &str, hint: &str) -> Response {
    (status, Json(json!({"error": error, "hint": hint}))).into_response()
}

fn internal(context: &'static str, failure: &anyhow::Error) -> Response {
    // The failure names a store or parse step, never a context or a policy.
    tracing::error!(error = %failure, context, "agent-hooks route failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", context)
}

/// The agent framework asking for a verdict: a native session or the
/// operator. Never an agent capability or a browser grant.
fn framework_caller(st: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    if let Ok((_, claims)) = require_session(st, headers) {
        if claims.credential_kind != CredentialKind::NativeSession {
            return Err(error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "only a native session or the operator may call this route, never an agent or a browser grant",
            ));
        }
        return Ok(Caller::Session {
            subject: crate::middleware::auth::session_subject(&claims),
            organization_id: claims.organization_id,
            role: claims.organization_role,
        });
    }
    require_operator(st, headers)?;
    Ok(Caller::Operator)
}

/// The policy is integration configuration: owner/admin or the operator, and
/// — like a verdict — never through an agent capability or a browser grant,
/// whatever role it carries. The guards refuse both first; this holds even if
/// a ceiling one day maps the path.
fn policy_caller(st: &AppState, headers: &HeaderMap) -> Result<Caller, Response> {
    let who = framework_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner or admin role required to read or replace the agent-hooks policy",
        ));
    }
    Ok(who)
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

/// Read at most `limit` bytes; `Err(true)` when the body is longer.
async fn bounded(headers: &HeaderMap, body: Body, limit: usize) -> Result<Bytes, bool> {
    if declared_length(headers).is_some_and(|length| length > limit) {
        return Err(true);
    }
    axum::body::to_bytes(body, limit).await.map_err(|failure| {
        std::error::Error::source(&failure)
            .is_some_and(<dyn std::error::Error>::is::<http_body_util::LengthLimitError>)
    })
}

/// The verdict for one request body, and the point it named.
async fn verdict_for(
    loaded: &LoadedHookPolicy,
    headers: &HeaderMap,
    body: Body,
) -> (
    Verdict,
    Option<opensesame_agent_hooks::sdk::InterceptionPoint>,
) {
    let bytes = match bounded(headers, body, MAX_CONTEXT_BYTES).await {
        Ok(bytes) => bytes,
        Err(true) => return (oversized_verdict(), None),
        Err(false) => {
            let verdict = Verdict::deny(
                Some(REASON_CONTEXT_UNREADABLE.into()),
                Some("context could not be read".into()),
            );
            return (verdict, None);
        }
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return (not_utf8_verdict(), None);
    };
    (
        loaded.interceptor().decide_json(text),
        interception_point(text),
    )
}

/// `POST /api/v1/agent-hooks/intercept` — one verdict.
pub async fn intercept(State(st): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let who = match framework_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let loaded = match load_policy(&st.db, &organization_id).await {
        Ok(loaded) => loaded,
        Err(failure) => return internal("load agent-hooks policy", &failure),
    };
    let (verdict, point) = verdict_for(&loaded, &headers, body).await;
    let record = DecisionRecord {
        organization_id: &organization_id,
        caller: who.actor_subject(),
        point,
        verdict: &verdict,
        policy_version: loaded.version,
    };
    if let Err(failure) = record_decision(&st.db, &record).await {
        // An unrecorded verdict is not handed out; the host denies (§6.3).
        return internal("record agent-hooks decision", &failure);
    }
    let mut response = Json(verdict).into_response();
    response
        .headers_mut()
        .insert(POLICY_VERSION_HEADER, HeaderValue::from(loaded.version));
    response
}

fn policy_response(loaded: &LoadedHookPolicy) -> Response {
    let stored = loaded.stored.as_ref();
    let body = json!({
        "spec": SPEC_VERSION,
        "version": loaded.version,
        "stored": stored.is_some(),
        "policy": loaded.policy,
        "updated_at": stored.map(|row| row.updated_at.as_str()),
        "updated_by": stored.map(|row| row.updated_by.as_str()),
    });
    let mut response = Json(body).into_response();
    let headers = response.headers_mut();
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{}\"", loaded.version)) {
        headers.insert(header::ETAG, etag);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `GET /api/v1/agent-hooks/policy`.
pub async fn get_policy(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let who = match policy_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match load_policy(&st.db, &organization_id).await {
        Ok(loaded) => policy_response(&loaded),
        Err(failure) => internal("load agent-hooks policy", &failure),
    }
}

/// The version `If-Match` names: exactly one strong entity tag of digits.
fn expected_version(headers: &HeaderMap) -> Result<i64, Response> {
    let Some(raw) = headers.get(header::IF_MATCH) else {
        return Err(error(
            StatusCode::PRECONDITION_REQUIRED,
            "precondition_required",
            "If-Match: \"<version>\" from GET /api/v1/agent-hooks/policy is required",
        ));
    };
    raw.to_str()
        .ok()
        .map(str::trim)
        .and_then(|tag| tag.strip_prefix('"')?.strip_suffix('"'))
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|digits| digits.parse::<i64>().ok())
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "If-Match must be one strong entity tag naming a policy version, like \"3\"",
            )
        })
}

/// A replacement, parsed and canonical: what is stored is what the
/// interceptor reads back.
async fn parsed_policy(headers: &HeaderMap, body: Body) -> Result<HookPolicy, Response> {
    let bytes = bounded(headers, body, MAX_POLICY_BYTES)
        .await
        .map_err(|oversized| {
            if oversized {
                error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "an agent-hooks policy is at most 256 KiB",
                )
            } else {
                error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "the body could not be read",
                )
            }
        })?;
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_policy",
            "an agent-hooks policy is UTF-8 JSON",
        )
    })?;
    HookPolicy::parse(text).map_err(|refused| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_policy",
            &refused.to_string(),
        )
    })
}

fn update_audit(
    organization_id: &OrganizationId,
    who: &Caller,
    expected: i64,
    canonical: &str,
) -> Value {
    json!({
        "organization_id": organization_id.to_string(),
        "updated_by": who.actor_subject(),
        "previous_version": expected,
        "version": expected.saturating_add(1),
        "policy_sha256": hex::encode(Sha256::digest(canonical.as_bytes())),
    })
}

/// `PUT /api/v1/agent-hooks/policy` — compare-and-set replacement.
pub async fn put_policy(State(st): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let who = match policy_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    // The loop this policy governs may be running under this very role: the
    // operator, or a step-up the role alone does not give (`step_up`).
    if let Err(response) =
        step_up::require_step_up(&st, &headers, &who, "replace the agent-hooks policy")
    {
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
    let policy = match parsed_policy(&headers, body).await {
        Ok(policy) => policy,
        Err(response) => return response,
    };
    let canonical = match serde_json::to_string(&policy) {
        Ok(text) => text,
        Err(failure) => return internal("serialize agent-hooks policy", &failure.into()),
    };
    let organization = organization_id.to_string();
    let audit = update_audit(&organization_id, &who, expected, &canonical).to_string();
    let write = AgentHookPolicyWrite {
        organization_id: &organization,
        policy_json: &canonical,
        expected_version: expected,
        updated_by: who.actor_subject(),
    };
    let audit = AgentHookPolicyAudit {
        event_type: EVENT_POLICY_UPDATED,
        payload_json: &audit,
    };
    match st.db.put_agent_hook_policy(&write, &audit).await {
        Ok(AgentHookPolicyWriteOutcome::Written(row)) => policy_response(&LoadedHookPolicy {
            policy,
            version: row.version,
            stored: Some(row),
        }),
        Ok(AgentHookPolicyWriteOutcome::Conflict { current_version }) => (
            StatusCode::PRECONDITION_FAILED,
            Json(json!({
                "error": "precondition_failed",
                "hint": "the policy changed since that version was read; GET it again and reapply",
                "current_version": current_version,
            })),
        )
            .into_response(),
        Err(failure) => internal("store agent-hooks policy", &failure),
    }
}

#[cfg(test)]
#[path = "agent_hooks_tests.rs"]
mod tests;
