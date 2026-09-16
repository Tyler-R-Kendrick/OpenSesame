//! Access-domain forest routes (ADR 0120). Operator or owner/admin session.
//! Realm is part of the path and must match the caller's organization — a
//! cross-realm parent is refused by storage; a cross-realm path is hidden.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_domain::{AccessDomainId, OrganizationId};
use opensesame_storage::authority::{AccessDomain, DomainReparent, NewAccessDomain};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};
use super::secret_configs::access::hidden;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/organizations/{organization}/access-domains",
            get(list).post(create),
        )
        .route(
            "/api/v1/organizations/{organization}/access-domains/{id}",
            get(get_one),
        )
        .route(
            "/api/v1/organizations/{organization}/access-domains/{id}/reparent",
            post(reparent),
        )
        .route(
            "/api/v1/organizations/{organization}/access-domains/{id}/terminate",
            post(terminate),
        )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    id: Option<String>,
    parent_id: Option<String>,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReparentBody {
    parent_id: Option<String>,
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminateBody {
    expected_revision: i64,
}

fn domain_json(domain: &AccessDomain) -> serde_json::Value {
    json!({
        "id": domain.id,
        "organization_id": domain.organization_id,
        "parent_id": domain.parent_id,
        "project_id": domain.project_id,
        "lifecycle": domain.lifecycle,
        "revision": domain.revision,
        "depth": domain.depth,
    })
}

#[allow(clippy::result_large_err)]
fn authorize_realm(
    st: &AppState,
    headers: &HeaderMap,
    path_organization: &str,
) -> Result<(Caller, OrganizationId), Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to manage access domains"
            })),
        )
            .into_response());
    }
    let organization = resolve_caller_organization(st, &who, headers)?;
    if organization.to_string() != path_organization {
        return Err(hidden());
    }
    Ok((who, organization))
}

fn unavailable() -> Response {
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

fn refused() -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error": "refused"})),
    )
        .into_response()
}

async fn list(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(organization): Path<String>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    match st.db.list_access_domains(&organization.to_string()).await {
        Ok(domains) => Json(json!({
            "items": domains.iter().map(domain_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(_) => unavailable(),
    }
}

async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(organization): Path<String>,
    Json(body): Json<CreateBody>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let id = body
        .id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| AccessDomainId::new().to_string());
    let org = organization.to_string();
    let created = match st
        .db
        .create_access_domain(&NewAccessDomain {
            id: &id,
            organization_id: &org,
            parent_id: body.parent_id.as_deref(),
            project_id: body.project_id.as_deref(),
        })
        .await
    {
        Ok(created) => created,
        Err(_) => return unavailable(),
    };
    if !created {
        return refused();
    }
    match st.db.access_domain(&org, &id).await {
        Ok(Some(domain)) => (StatusCode::CREATED, Json(domain_json(&domain))).into_response(),
        Ok(None) => unavailable(),
        Err(_) => unavailable(),
    }
}

async fn get_one(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, id)): Path<(String, String)>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    match st.db.access_domain(&organization.to_string(), &id).await {
        Ok(Some(domain)) => Json(domain_json(&domain)).into_response(),
        Ok(None) => hidden(),
        Err(_) => unavailable(),
    }
}

async fn reparent(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, id)): Path<(String, String)>,
    Json(body): Json<ReparentBody>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let org = organization.to_string();
    let moved = match st
        .db
        .reparent_access_domain(&DomainReparent {
            organization_id: &org,
            id: &id,
            expected_revision: body.expected_revision,
            new_parent_id: body.parent_id.as_deref(),
        })
        .await
    {
        Ok(moved) => moved,
        Err(_) => return unavailable(),
    };
    if !moved {
        return refused();
    }
    match st.db.access_domain(&org, &id).await {
        Ok(Some(domain)) => Json(domain_json(&domain)).into_response(),
        Ok(None) => unavailable(),
        Err(_) => unavailable(),
    }
}

async fn terminate(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, id)): Path<(String, String)>,
    Json(body): Json<TerminateBody>,
) -> Response {
    let (_, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let org = organization.to_string();
    let terminated = match st
        .db
        .terminate_access_domain(&org, &id, body.expected_revision)
        .await
    {
        Ok(terminated) => terminated,
        Err(_) => return unavailable(),
    };
    if !terminated {
        return refused();
    }
    match st.db.access_domain(&org, &id).await {
        Ok(Some(domain)) => Json(domain_json(&domain)).into_response(),
        Ok(None) => unavailable(),
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
#[path = "access_domains_tests.rs"]
mod tests;
