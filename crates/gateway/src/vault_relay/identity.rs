use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use super::admit::{org_role_of, principal_of, OrgRole};
use super::registration::{token_from_headers, Verifier};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RequestIdentity {
    pub(crate) principal: String,
    pub(crate) role: Option<OrgRole>,
    /// Set only when a registration JWT names the vault owner.
    pub(crate) owner: Option<String>,
}

pub(crate) fn resolve_identity(
    headers: &HeaderMap,
    verifier: Option<&Verifier>,
    now: i64,
) -> Result<RequestIdentity, (StatusCode, Json<Value>)> {
    if let Some(verifier) = verifier {
        let token = token_from_headers(headers).ok_or_else(unauthorized)?;
        let claims = verifier.verify(&token, now).map_err(|_| unauthorized())?;
        let identity = Verifier::identity_from_claims(&claims);
        return Ok(RequestIdentity {
            principal: identity.principal,
            role: identity.role,
            owner: identity.owner,
        });
    }
    let role =
        org_role_of(headers).map_err(|status| (status, Json(json!({ "error": "malformed" }))))?;
    Ok(RequestIdentity {
        principal: principal_of(headers),
        role,
        owner: None,
    })
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
}
