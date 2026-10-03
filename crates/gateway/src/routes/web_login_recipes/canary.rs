//! `POST /api/v1/web-login/recipes/{origin}/canary` — one attended run.
//!
//! An unattended run needs a recipe a real change has proven, and the first
//! proof has to come from a run somebody is watching. This starts one: the
//! caller's own browser drives it (they are the run's owner, and only the
//! owner may claim its steps — ADR 0081 §8), and a completed run is recorded
//! as the recipe's canary by the Host. The recipe must already be signed by a
//! pinned key; an unverified recipe is never replayed, attended or not.
//!
//! A person starts it — a native session of an owner or admin, the same role
//! that writes the recipe, never an agent capability, a browser grant or a
//! session whose ceiling carries agent capabilities, and never the operator,
//! who has no browser to drive. The run answers `202` and goes on without the request;
//! its outcome is on the `agent.*` feed and the rotation job.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde_json::json;

use super::{error, origin_of};
use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, require_session, session_subject};
use crate::routes::agent_hooks::step_up::{fresh_step_up, StepUpRefusal};
use crate::session_claims::CredentialKind;
use crate::web_login::recipe_trust::{verified_recipe, Attendance, Unrunnable};
use crate::web_login::{registry::Refused, run_held, start_attended};

/// The person asking, and the organization they act in.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
fn person(
    st: &AppState,
    headers: &HeaderMap,
) -> Result<(opensesame_domain::OrganizationId, String), Response> {
    let claims = match require_session(st, headers) {
        Ok((_, claims)) => claims,
        Err(refusal) => {
            return Err(if require_operator(st, headers).is_ok() {
                error(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "an attended run is driven from a person's own browser; the operator has none",
                )
            } else {
                refusal
            });
        }
    };
    let delegated = matches!(
        fresh_step_up(&claims, Utc::now()),
        Err(StepUpRefusal::Delegated)
    );
    if claims.credential_kind != CredentialKind::NativeSession || delegated {
        return Err(error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only a person's own native session may start a run, never an agent or a browser grant",
        ));
    }
    // Starting a run changes a real credential at a real site, so it takes the
    // same role as writing the recipe: a member or viewer of the organization
    // may not rotate a login that is not theirs to rotate.
    if !claims.organization_role.can_configure_integrations() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner or admin role required to start an attended web-login run",
        ));
    }
    Ok((claims.organization_id, session_subject(&claims)))
}

/// `POST /api/v1/web-login/recipes/{origin}/canary`.
pub(super) async fn start(
    State(st): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (organization_id, owner) = match person(&st, &headers) {
        Ok(found) => found,
        Err(response) => return response,
    };
    let origin = match origin_of(&raw) {
        Ok(origin) => origin,
        Err(response) => return response,
    };
    let verdict = verified_recipe(
        &st.db,
        &organization_id.to_string(),
        &origin,
        Attendance::Attended,
        Utc::now(),
    )
    .await;
    if let Err(why) = verdict {
        return match why {
            Unrunnable::Unreadable => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "web-login recipes could not be read",
            ),
            Unrunnable::NoRecipe | Unrunnable::NoCanary | Unrunnable::Invalid => error(
                StatusCode::CONFLICT,
                "recipe_not_runnable",
                "no verified recipe is stored for that origin: store one signed by a pinned key first",
            ),
        };
    }
    if run_held(&st, &organization_id, &origin).await {
        return error(
            StatusCode::CONFLICT,
            "run_in_flight",
            "a run for that origin is already queued or executing",
        );
    }
    match start_attended(&st, &organization_id, &origin, &owner) {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "status": "started",
                "origin": origin,
                "hint": "drive it from your browser; follow it with `opensesame access connectors rotate runs`",
            })),
        )
            .into_response(),
        Err(Refused::InFlight) => error(
            StatusCode::CONFLICT,
            "run_in_flight",
            "a run for that origin is already queued or executing",
        ),
        Err(Refused::Full) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runner_busy",
            "the runner has too many runs queued; try again shortly",
        ),
    }
}
