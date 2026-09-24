//! Enforcement fence on the invoke path.
//!
//! Catalog lookup is fail-closed: if the catalog cannot load, the use is
//! denied rather than authorized against an unjudged surface.

use super::{InvokeBody, ResolvedInvocation};
use crate::app_state::AppState;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_authz::{authorize_authority_use_enforced, descriptor_for_invoke, AuthorityUse};
use opensesame_domain::{AuthorityOperation, InvokeLevel};
use serde_json::{json, Value};

/// # Errors
///
/// Forbidden when the catalog cannot load, the platform cannot hold the
/// grant, or policy denies the use.
#[allow(clippy::result_large_err)]
pub(super) fn authorize_invocation(
    st: &AppState,
    subject: &str,
    body: &InvokeBody,
    parameters: &Value,
    resolved: &ResolvedInvocation,
    level: u8,
) -> Result<(), Response> {
    let invoke_level = match level {
        1 => InvokeLevel::TypedOperation,
        2 => InvokeLevel::ConstrainedHttp,
        _ => InvokeLevel::Materialize,
    };
    let authority_use = AuthorityUse {
        subject,
        grant: &resolved.grant,
        binding: &resolved.binding,
        op: AuthorityOperation::Invoke,
        level: invoke_level,
        requested_url: parameters.get("url").and_then(Value::as_str),
        requested_action: Some(&body.operation),
        connection_policy_id: &resolved.connection_policy_id,
        lineage: resolved.lineage.as_ref(),
    };
    let descriptor = descriptor_for_invoke(invoke_level).map_err(|error| deny_authz(&error))?;
    match authorize_authority_use_enforced(&st.broker.policy, &authority_use, &descriptor) {
        Ok(decision) if decision.allowed => Ok(()),
        Ok(_) => Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error":"authority_denied","type":"about:blank"})),
        )
            .into_response()),
        Err(error) => Err(deny_authz(&error)),
    }
}

fn deny_authz(error: &impl ToString) -> Response {
    let message = opensesame_redaction::redact_text(&error.to_string());
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": message, "type":"about:blank"})),
    )
        .into_response()
}
