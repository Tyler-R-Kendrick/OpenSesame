//! Human-only configuration. Detection never activates duress or grants authority.
use super::agent_hooks::step_up::require_step_up;
use crate::{
    app_state::AppState,
    middleware::auth::{require_operator, require_session, resolve_caller_organization, Caller},
    session_claims::CredentialKind,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_domain::{ConnectionId, OrganizationId};
use opensesame_human_vault::credential_canaries::Artifact;
use opensesame_storage::credential_canaries::HostCanaryBinding;
use serde::Deserialize;
use serde_json::json;
#[cfg(test)]
mod tests;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/credential-canaries/register", post(register))
        .route("/api/v1/credential-canaries/issued", post(issue))
        .route(
            "/api/v1/credential-canaries/issued/{issuer_record_ref}/retire",
            post(retire),
        )
        .route("/api/v1/credential-canaries/{tomb}", get(status))
        .route(
            "/api/v1/credential-canaries/{tomb}/events",
            axum::routing::delete(clear_events),
        )
        .route(
            "/api/v1/credential-canaries/{tomb}/{artifact_id}",
            axum::routing::delete(remove),
        )
        .layer(DefaultBodyLimit::max(4096))
}
fn refusal(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
fn management_org(st: &AppState, headers: &HeaderMap) -> Result<OrganizationId, Response> {
    let who = if let Ok((_, claims)) = require_session(st, headers) {
        if claims.credential_kind != CredentialKind::NativeSession {
            return Err(refusal(StatusCode::FORBIDDEN, "human_credential_required"));
        }
        Caller::Session {
            subject: crate::middleware::auth::session_subject(&claims),
            organization_id: claims.organization_id,
            role: claims.organization_role,
        }
    } else {
        require_operator(st, headers)?;
        Caller::Operator
    };
    if !who.can_configure_integrations() {
        return Err(refusal(StatusCode::FORBIDDEN, "owner_or_admin_required"));
    }
    require_step_up(st, headers, &who, "manage credential canaries")?;
    resolve_caller_organization(st, &who, headers)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterBody {
    tomb: String,
    vault_identity: String,
    artifact: Artifact,
}
async fn register(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let binding = HostCanaryBinding {
        organization_id: org,
        tomb: body.tomb,
        vault_identity: body.vault_identity,
    };
    match st
        .db
        .register_controlled_canary(&binding, &body.artifact)
        .await
    {
        Ok(()) => (StatusCode::CREATED, Json(json!({"registered":true}))).into_response(),
        Err(_) => refusal(StatusCode::BAD_REQUEST, "controlled_binding_refused"),
    }
}
async fn status(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(tomb): Path<String>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match st.db.controlled_canary_status(&org, &tomb).await {
        Ok(v) => Json(v).into_response(),
        Err(_) => refusal(StatusCode::NOT_FOUND, "controlled_binding_unavailable"),
    }
}
async fn remove(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((tomb, id)): Path<(String, String)>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match st.db.remove_controlled_canary(&org, &tomb, &id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => refusal(StatusCode::BAD_REQUEST, "controlled_artifact_refused"),
    }
}
async fn clear_events(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(tomb): Path<String>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match st.db.clear_controlled_canary_events(&org, &tomb).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => refusal(StatusCode::BAD_REQUEST, "controlled_binding_refused"),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssueBody {
    tomb: String,
    connection_id: ConnectionId,
    expires_at: String,
}
async fn issue(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IssueBody>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match st
        .db
        .issue_controlled_alias(&org, &body.tomb, &body.connection_id, &body.expires_at)
        .await
    {
        Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
        Err(_) => refusal(StatusCode::BAD_REQUEST, "controlled_alias_refused"),
    }
}
async fn retire(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let org = match management_org(&st, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match st.db.retire_controlled_alias(&org, &id).await {
        Ok(v) => Json(v).into_response(),
        Err(_) => refusal(StatusCode::BAD_REQUEST, "issued_credential_refused"),
    }
}
