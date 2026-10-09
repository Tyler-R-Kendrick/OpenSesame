//! Enforcement preflight for generalized authority issuance.
//!
//! Runs before `issue_authority` so a refused platform never writes a sidecar.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_authz::{admit_issuance, parse_offline_use, IssuanceGrantTerms};
use serde_json::json;

/// # Errors
///
/// 400 when `offline_use` is not a known variant; 422 when the named
/// platform cannot hold the grant's terms (including catalog failure).
#[allow(clippy::result_large_err)]
pub(super) fn preflight(
    platform: Option<&str>,
    offline_use: Option<&str>,
    raw_credential_export: Option<bool>,
) -> Result<(), Response> {
    let platform = platform.unwrap_or("host-brokered-invocation");
    let Ok(offline_use) = parse_offline_use(offline_use) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "bad_request",
                "hint": "offline_use must be forbidden, read_only, or pre_authorized"
            })),
        )
            .into_response());
    };
    admit_issuance(
        platform,
        IssuanceGrantTerms {
            offline_use,
            raw_credential_export: raw_credential_export.unwrap_or(false),
        },
    )
    .map(|_| ())
    .map_err(|refused| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "enforcement_refused",
                "platform": platform,
                "hint": refused.to_string(),
            })),
        )
            .into_response()
    })
}
