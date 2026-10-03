//! A hosted run's agent-hooks record, read (ADR 0159, ADR 0081).
//!
//! A run the Host opened has no viewer key to seal a log to (ADR 0081 §9 puts
//! that key in the owner's client), so its sealed log is empty by construction
//! and its observation is the record of every verdict its interceptors gave:
//! interception point, decision, a machine reason, digests. Nothing here can
//! carry a target, a message or a transform's value — the table has no column
//! for one — so the same entitlement as the sealed log (`Attachment::View`, the
//! credential's owner and nobody else) reads it without widening anything.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_session_observe::Attachment;
use opensesame_storage::agent_hook_records::{AgentHookRecordSummary, HOOK_RECORD_PAGE_LIMIT};
use opensesame_storage::web_login_runs::StoredAgentHookRecord;
use opensesame_storage::{StoredObservationRun, NO_VIEWER_KEY_PREFIX};
use serde::Deserialize;
use serde_json::{json, Value};

use super::load;
use crate::app_state::AppState;

/// Records a page holds when the caller names no `limit`.
const DEFAULT_PAGE: usize = 64;

/// What observes this run: its sealed log (a viewer key exists), or only the
/// hook records (the Host opened it and holds no key to seal with).
pub(super) fn observation_kind(run: &StoredObservationRun) -> &'static str {
    if run.viewer_key_id.starts_with(NO_VIEWER_KEY_PREFIX) {
        "hook_records_only"
    } else {
        "sealed_log"
    }
}

/// The count-and-verdict summary as the run view carries it. Counts only.
pub(super) fn summary_view(summary: &AgentHookRecordSummary) -> Value {
    json!({
        "count": summary.count,
        "allow": summary.allow,
        "deny": summary.deny,
        "transform": summary.transform,
        "escalated": summary.escalated,
        "last_sequence": summary.last_sequence,
    })
}

/// One record: the payload-free §10.3 projection, and nothing the row lacks.
fn record_view(record: &StoredAgentHookRecord) -> Value {
    json!({
        "sequence": record.sequence,
        "interception_point": record.interception_point,
        "decision": record.decision,
        "escalated": record.escalated,
        "reason": record.reason,
        "decided_by": record.decided_by,
        "input_identity": record.input_identity,
        "enforced_identity": record.enforced_identity,
        "policy_version": record.policy_version,
        "recorded_at": record.recorded_at,
    })
}

fn internal(error: &anyhow::Error, what: &str) -> Response {
    tracing::error!(%error, "{what}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal"})),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct HookRecordsQuery {
    /// Last `sequence` the client already has. Omit to read from the start.
    #[serde(default = "default_after")]
    pub after: i64,
    /// Most records to return; capped at the page limit.
    #[serde(default)]
    pub limit: Option<usize>,
}

const fn default_after() -> i64 {
    -1
}

/// `GET /api/v1/agent/runs/{id}/hook-records` — one page of the run's
/// agent-hooks records, by `sequence`.
///
/// The same tenancy and owner rules as `log`: a run that is not the caller's
/// is a 404 that does not admit it exists. Records are the payload-free
/// projection; `sealed: false` says they are not ciphertext, and `secrets_returned`
/// stays `false` because the row has nowhere to keep one.
pub async fn read_hook_records(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HookRecordsQuery>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE)
        .clamp(1, HOOK_RECORD_PAGE_LIMIT);
    let records = match st
        .db
        .agent_hook_records_after(&organization_id, &run.id, query.after, limit)
        .await
    {
        Ok(records) => records,
        Err(error) => return internal(&error, "hook records could not be read"),
    };
    let summary = match st
        .db
        .agent_hook_record_summary(&organization_id, &run.id)
        .await
    {
        Ok(summary) => summary,
        Err(error) => return internal(&error, "hook record summary could not be read"),
    };
    let next_after = records.last().map_or(query.after, |record| record.sequence);
    let has_more = summary.last_sequence.is_some_and(|last| last > next_after);
    Json(json!({
        "run_id": run.id,
        "records": records.iter().map(record_view).collect::<Vec<_>>(),
        "next_after": next_after,
        "has_more": has_more,
        "summary": summary_view(&summary),
        "observation": observation_kind(&run),
        "sealed": false,
        "secrets_returned": false,
    }))
    .into_response()
}

/// The summary for `get_run`, or the 500 to answer with.
pub(super) async fn summary_of(
    st: &AppState,
    organization_id: &str,
    run_id: &str,
) -> Result<Value, Response> {
    st.db
        .agent_hook_record_summary(organization_id, run_id)
        .await
        .map(|summary| summary_view(&summary))
        .map_err(|error| internal(&error, "hook record summary could not be read"))
}
