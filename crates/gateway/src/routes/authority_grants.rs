//! Issue generalized authority onto an existing grant row (ADR 0120).
//!
//! Storage: `issue_authority`. The legacy `grants` envelope must already exist;
//! this route records the domain, lineage, digests, and correlated entries.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use opensesame_storage::authority::{AuthorityIssue, PermissionEntry};
use serde::Deserialize;
use serde_json::json;

use super::super::secret_configs::access::hidden;
use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

#[path = "authority_issuance_preflight.rs"]
mod issuance_preflight;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v1/organizations/{organization}/grants/{grant_id}/authority",
        post(issue),
    )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryBody {
    resource_selector: String,
    provider_operation_id: String,
    action_set: Vec<String>,
    parameter_constraints: serde_json::Value,
    audience_set: Vec<String>,
    manifest_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IssueBody {
    domain_id: String,
    parent_grant_id: Option<String>,
    issuance_basis: String,
    lineage_digest: String,
    policy_digest: String,
    role_revision: Option<i64>,
    offer_id: Option<String>,
    delegation_depth_remaining: i64,
    not_before: String,
    expires_at: String,
    evidence_id: Option<String>,
    entries: Vec<EntryBody>,
    /// Catalog platform the grant's terms must be holdable on. Defaults to
    /// `host-brokered-invocation`. Absent adapters (apple-ios, discord-live, …)
    /// refuse rather than mint a sidecar.
    enforcement_platform: Option<String>,
    offline_use: Option<String>,
    raw_credential_export: Option<bool>,
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
                "hint": "owner or admin role required to issue authority"
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

const RESERVED_ISSUE_ACTIONS: &[&str] = &["credential.export", "policy.edit"];
// INV-GA-04 / contracts: maximum_delegation_depth ≤ 2; remaining budget
// cannot advertise more depth than the product ceiling.
const MAX_DELEGATION_DEPTH_REMAINING: i64 = 2;

fn entries_include_reserved(entries: &[PermissionEntry]) -> bool {
    entries.iter().any(|entry| {
        serde_json::from_str::<Vec<String>>(&entry.action_set_json)
            .ok()
            .is_some_and(|actions| {
                actions
                    .iter()
                    .any(|action| RESERVED_ISSUE_ACTIONS.contains(&action.as_str()))
            })
    })
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

fn bad_request(hint: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": "bad_request", "hint": hint})),
    )
        .into_response()
}

fn parse_instant(raw: &str) -> Result<DateTime<Utc>, Response> {
    DateTime::parse_from_rfc3339(raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| bad_request("not_before and expires_at must be RFC3339"))
}

fn entries_from_body(body: &[EntryBody]) -> Result<Vec<PermissionEntry>, Response> {
    if body.is_empty() {
        return Err(bad_request("at least one permission entry is required"));
    }
    let mut entries = Vec::with_capacity(body.len());
    for entry in body {
        if entry.action_set.is_empty() {
            return Err(bad_request("each entry needs a non-empty action_set"));
        }
        entries.push(PermissionEntry {
            resource_selector: entry.resource_selector.clone(),
            provider_operation_id: entry.provider_operation_id.clone(),
            action_set_json: serde_json::to_string(&entry.action_set).map_err(|_| unavailable())?,
            parameter_constraints_json: serde_json::to_string(&entry.parameter_constraints)
                .map_err(|_| unavailable())?,
            audience_set_json: serde_json::to_string(&entry.audience_set)
                .map_err(|_| unavailable())?,
            manifest_digest: entry.manifest_digest.clone(),
        });
    }
    Ok(entries)
}

async fn issue(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((organization, grant_id)): Path<(String, String)>,
    Json(body): Json<IssueBody>,
) -> Response {
    let (who, organization) = match authorize_realm(&st, &headers, &organization) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let org = organization.to_string();
    let not_before = match parse_instant(&body.not_before) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let expires_at = match parse_instant(&body.expires_at) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let entries = match entries_from_body(&body.entries) {
        Ok(entries) => entries,
        Err(response) => return response,
    };
    if let Err(response) = issuance_preflight::preflight(
        body.enforcement_platform.as_deref(),
        body.offline_use.as_deref(),
        body.raw_credential_export,
    ) {
        return response;
    }
    if (body.raw_credential_export == Some(true) || entries_include_reserved(&entries))
        && !who.may_issue_reserved_administration()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "reserved administration requires higher-scope issuance"
            })),
        )
            .into_response();
    }
    if body.delegation_depth_remaining < 0
        || body.delegation_depth_remaining > MAX_DELEGATION_DEPTH_REMAINING
    {
        return bad_request("delegation_depth_remaining must be 0..=2");
    }
    let issued = match st
        .db
        .issue_authority(
            &AuthorityIssue {
                grant_id: &grant_id,
                organization_id: &org,
                domain_id: &body.domain_id,
                parent_grant_id: body.parent_grant_id.as_deref(),
                issuance_basis: &body.issuance_basis,
                lineage_digest: &body.lineage_digest,
                policy_digest: &body.policy_digest,
                role_revision: body.role_revision,
                offer_id: body.offer_id.as_deref(),
                delegation_depth_remaining: body.delegation_depth_remaining,
                not_before,
                expires_at,
                evidence_id: body.evidence_id.as_deref(),
            },
            &entries,
        )
        .await
    {
        Ok(issued) => issued,
        Err(error) => {
            let message = error.to_string();
            if message.contains("permission entry") || message.contains("interval") {
                return bad_request(&message);
            }
            return unavailable();
        }
    };
    if !issued {
        return refused();
    }
    // Projection is a cache (storage.md §5): issue already committed. A failed
    // live apply leaves the projection unmarked so freshness stays fail-closed.
    if let Err(error) = crate::openfga_project::project_grant_live(&st, &org, &grant_id).await {
        tracing::warn!(%error, grant_id, "openfga live projection failed after issue");
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "status": "issued",
            "grant_id": grant_id,
            "domain_id": body.domain_id,
        })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "authority_grants_tests.rs"]
mod tests;
