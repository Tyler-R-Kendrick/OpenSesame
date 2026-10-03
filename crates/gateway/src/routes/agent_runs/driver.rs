//! The driver's half of the step channel (ADR 0079 §4): the owner's browser
//! claims the run's outstanding step and settles what it did.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_session_observe::{AttachRefusal, Attachment};
use serde::Deserialize;
use serde_json::json;

use super::{load, outcome, refusal, scrub, subject_of};
use crate::app_state::AppState;

/// `POST /api/v1/agent/runs/{id}/steps/claim` — take the run's outstanding step.
///
/// The driver here is the owner's own browser, so the entitlement is the same
/// one that gates watching: a run belongs to whoever's credential it rotates,
/// and nobody else may drive it. Claiming is `Attachment::Control` for exactly
/// that reason — issuing input events into an authenticated third-party session
/// is the thing control means.
///
/// Returns 204 when there is nothing to do, so a polling driver has a cheap
/// answer rather than an error to interpret.
pub async fn claim_step(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(claimant) = subject_of(&who) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    let now = Utc::now();
    let expires_at = now + chrono::Duration::seconds(opensesame_storage::STEP_CLAIM_SECONDS);
    match st
        .db
        .claim_runner_step(
            &organization_id,
            &run.id,
            &claimant,
            &now.to_rfc3339(),
            &expires_at.to_rfc3339(),
        )
        .await
    {
        Ok(Some(step)) => Json(json!({
            "run_id": step.run_id,
            "seq": step.seq,
            // The StepRequest, verbatim. It names a credential reference and a
            // selector; it has no field able to carry a value.
            "request": serde_json::from_str::<serde_json::Value>(&step.request_json)
                .unwrap_or(serde_json::Value::Null),
            "claim_expires_at": step.claim_expires_at,
            "secrets_returned": false,
        }))
        .into_response(),
        // Nothing pending, or somebody else holds a live claim. A polling
        // driver wants a cheap answer here, not an error to interpret.
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "runner step could not be claimed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct OutcomeBody {
    /// The `StepOutcome` (or a custody outcome), checked against the step it
    /// answers and stored in its canonical encoding (`outcome`).
    pub outcome: serde_json::Value,
}

/// `POST /api/v1/agent/runs/{id}/steps/{seq}/outcome` — report what happened.
///
/// Only the claimant may, and a claim that lapsed is not a claim. A driver that
/// went away and came back finds its step taken and is told so, rather than
/// settling a step somebody else is now executing.
///
/// The outcome is checked against the step it answers before it is looked at
/// further (`outcome`): it must be one that step may produce, and carry exactly
/// that outcome's fields — a driver-added field is refused (422), never stored.
/// What is stored is the canonical encoding of what was decoded.
///
/// It is then stored **scrubbed and bounded**, whether or not anyone is
/// still waiting for it: a driver that settles after its step timed out (the
/// run still open, the executor gone) leaves a row no executor will read, and
/// that row holds markers, not the credential-shaped text it was sent.
pub async fn settle_step(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((run_id, seq)): Path<(String, i64)>,
    Json(body): Json<OutcomeBody>,
) -> Response {
    let (who, organization_id, run) = match load(&st, &headers, &run_id, Attachment::Control).await
    {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let Some(claimant) = subject_of(&who) else {
        return refusal(AttachRefusal::StepUpRequired);
    };
    // The step as it stands: it must be this caller's live claim before
    // anything the caller sent is looked at, and its request says which
    // outcomes may answer it.
    let step = match st.db.get_runner_step(&organization_id, &run.id, seq).await {
        Ok(Some(step))
            if step.state == "claimed" && step.claimed_by.as_deref() == Some(claimant.as_str()) =>
        {
            step
        }
        Ok(_) => return not_the_claimant(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "runner step could not be read");
            return internal();
        }
    };
    let typed = match outcome::canonical(&step.request_json, &body.outcome) {
        Ok(typed) => typed,
        Err(refused) => return refused.response(),
    };
    let scrubbed = match scrub::scrub(&st, &organization_id, &typed).await {
        Ok(scrubbed) => scrubbed,
        Err(refused) => return refused.response(),
    };
    match st
        .db
        .settle_runner_step(
            &organization_id,
            &run.id,
            seq,
            &claimant,
            scrubbed.encoded(),
            &Utc::now().to_rfc3339(),
        )
        .await
    {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({
                "status": "settled",
                "redacted": scrubbed.redacted(),
                "refused": scrubbed.refused(),
            })),
        )
            .into_response(),
        Ok(false) => not_the_claimant(),
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "runner step could not be settled");
            internal()
        }
    }
}

fn not_the_claimant() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": "not_the_claimant",
            "hint": "this step is not yours to settle, its claim has lapsed, or its run has closed"
        })),
    )
        .into_response()
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal"})),
    )
        .into_response()
}

#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;
