//! `GET /api/v1/agent-hooks/decisions` — the audit of every verdict the
//! Host's intercept route has answered for the organization (ADR 0159).
//!
//! The same gate as the policy it audits: owner/admin or the operator, and
//! never through an agent capability or a browser grant — an agent that could
//! read the trail of its own verdicts could probe the policy that governs it
//! one decision at a time.
//!
//! Newest first, `limit` at a time, with an opaque `next_cursor` that resumes
//! where a page ended even while more decisions are appended. Every filter is
//! an exact match, except `since` (inclusive) and `until` (exclusive) on the
//! time a verdict was answered. A row is value-blind by construction: the
//! interception point, the decision, whether it escalated, a reason that is a
//! short machine identifier, the policy version and who asked — never a tool
//! name, a target, a transform's value or a message (spec §14).

use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_agent_hooks::sdk::InterceptionPoint;
use opensesame_storage::agent_hook_policy::decisions::{
    AgentHookDecisionFilter, StoredAgentHookDecision,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{error, internal, policy_caller};
use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller_organization;

/// Rows returned when `limit` is not given.
pub(crate) const DEFAULT_LIMIT: i64 = 50;
/// Most rows one page may ask for.
pub(crate) const MAX_LIMIT: i64 = 100;
/// Longest text a filter may carry — the bound on a `reason` or a caller.
const MAX_FILTER_CHARS: usize = 256;

const DECISIONS: [&str; 3] = ["allow", "deny", "transform"];

/// The query string. Unknown parameters are refused rather than ignored: a
/// misspelt filter that quietly matched everything would read as "no such
/// decisions were escalated".
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionsQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    decision: Option<String>,
    interception_point: Option<String>,
    caller: Option<String>,
    reason: Option<String>,
    escalated: Option<bool>,
    policy_version: Option<i64>,
    since: Option<String>,
    until: Option<String>,
}

fn invalid(hint: &str) -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_request", hint)
}

fn bounded_text(name: &str, value: Option<String>) -> Result<Option<String>, Response> {
    match value {
        Some(text)
            if text.is_empty()
                || text.chars().count() > MAX_FILTER_CHARS
                || text.chars().any(char::is_control) =>
        {
            Err(invalid(&format!(
                "{name} must be 1 to {MAX_FILTER_CHARS} printable characters"
            )))
        }
        other => Ok(other),
    }
}

/// An RFC 3339 instant, normalized to the form the audit stores.
fn instant(name: &str, value: Option<&str>) -> Result<Option<String>, Response> {
    value
        .map(|raw| {
            DateTime::parse_from_rfc3339(raw)
                .map(|time| time.with_timezone(&Utc).to_rfc3339())
                .map_err(|_| invalid(&format!("{name} must be an RFC 3339 timestamp")))
        })
        .transpose()
}

fn filter_of(query: &DecisionsQuery) -> Result<AgentHookDecisionFilter, Response> {
    let decision = match query.decision.as_deref() {
        Some(named) if !DECISIONS.contains(&named) => {
            return Err(invalid("decision must be allow, deny or transform"));
        }
        other => other.map(str::to_owned),
    };
    let interception_point = match query.interception_point.as_deref() {
        Some(named)
            if serde_json::from_value::<InterceptionPoint>(Value::String(named.into()))
                .is_err() =>
        {
            return Err(invalid(
                "interception_point must be one of the eight agent-hooks/0.1 points",
            ));
        }
        other => other.map(str::to_owned),
    };
    if query.policy_version.is_some_and(|version| version < 0) {
        return Err(invalid("policy_version is never negative"));
    }
    Ok(AgentHookDecisionFilter {
        decision,
        interception_point,
        caller: bounded_text("caller", query.caller.clone())?,
        reason: bounded_text("reason", query.reason.clone())?,
        escalated: query.escalated,
        policy_version: query.policy_version,
        since: instant("since", query.since.as_deref())?,
        until: instant("until", query.until.as_deref())?,
    })
}

/// The cursor is the id of the last row of the page before: digits only.
fn cursor_of(raw: Option<&str>) -> Result<Option<i64>, Response> {
    raw.map(|text| {
        text.parse::<i64>()
            .ok()
            .filter(|id| *id > 0 && text.bytes().all(|byte| byte.is_ascii_digit()))
            .ok_or_else(|| invalid("cursor is the next_cursor of an earlier page"))
    })
    .transpose()
}

fn view(row: &StoredAgentHookDecision) -> Value {
    json!({
        "id": row.id,
        "caller": row.caller,
        "interception_point": row.interception_point,
        "decision": row.decision,
        "escalated": row.escalated,
        "reason": row.reason,
        "policy_version": row.policy_version,
        "created_at": row.created_at,
    })
}

/// `GET /api/v1/agent-hooks/decisions`.
pub async fn list(
    State(st): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<DecisionsQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let who = match policy_caller(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization_id = match resolve_caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Ok(Query(query)) = query else {
        return invalid(
            "the query names a parameter this route does not take, or one of the wrong type",
        );
    };
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return invalid(&format!("limit is 1 to {MAX_LIMIT}"));
    }
    let (filter, before) = match (filter_of(&query), cursor_of(query.cursor.as_deref())) {
        (Ok(filter), Ok(before)) => (filter, before),
        (Err(response), _) | (_, Err(response)) => return response,
    };
    // One row more than asked for says whether another page exists.
    let mut rows = match st
        .db
        .list_agent_hook_decisions(&organization_id.to_string(), &filter, before, limit + 1)
        .await
    {
        Ok(rows) => rows,
        Err(failure) => return internal("read agent-hooks decisions", &failure),
    };
    let more = i64::try_from(rows.len()).is_ok_and(|count| count > limit);
    rows.truncate(usize::try_from(limit).unwrap_or(0));
    let next_cursor = more
        .then(|| rows.last().map(|row| row.id.to_string()))
        .flatten();
    let mut response = Json(json!({
        "decisions": rows.iter().map(view).collect::<Vec<_>>(),
        "next_cursor": next_cursor,
        "retention_days": crate::retention::decision_retention_days(),
    }))
    .into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    response
}
