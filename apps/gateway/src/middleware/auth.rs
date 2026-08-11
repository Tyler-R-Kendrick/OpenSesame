use crate::app_state::AppState;
use crate::config;
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

fn session_organization(
    meta: &Value,
) -> Option<(
    opensesame_domain::OrganizationId,
    opensesame_domain::OrganizationRole,
)> {
    let organization_id = meta.get("organization_id")?.as_str()?;
    let organization_id = opensesame_domain::OrganizationId::parse(organization_id).ok()?;
    let role = serde_json::from_value(meta.get("organization_role")?.clone()).ok()?;
    Some((organization_id, role))
}

/// Requires an active opaque session token (`Authorization: Bearer opaque-session:…`).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_session(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(String, Value), Response> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
    else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"Bearer opaque-session:<id> required"})),
        )
            .into_response());
    };
    let Some(session_id) = token.strip_prefix("opaque-session:") else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"expected opaque-session token"})),
        )
            .into_response());
    };
    // Sessions are keyed by digest; the presented bearer is never stored, and the
    // handle returned here (used for sync-blob ownership) is the digest too.
    let session_digest = opensesame_claims::hash_secret(session_id);
    let mut sessions = st.sessions.lock().unwrap();
    let Some(meta) = sessions.get(&session_digest).cloned() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session"})),
        )
            .into_response());
    };
    let expired = meta
        .get("expires_at")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| chrono::Utc::now() >= dt.with_timezone(&chrono::Utc))
        .unwrap_or(true);
    if expired {
        sessions.remove(&session_digest);
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"session_expired"})),
        )
            .into_response());
    }
    if session_organization(&meta).is_none() {
        sessions.remove(&session_digest);
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session_claims"})),
        )
            .into_response());
    }
    Ok((session_digest, meta))
}

pub fn session_subject(meta: &Value) -> String {
    meta.get("approved_as")
        .or_else(|| meta.get("principal_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("user:demo")
        .to_string()
}

/// Human/operator mutations: `X-OpenSesame-Operator` or `Authorization: Bearer operator:<token>`.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_operator(st: &AppState, headers: &axum::http::HeaderMap) -> Result<(), Response> {
    if st.operator_token.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"operator_token_unconfigured"})),
        )
            .into_response());
    }
    let from_header = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| {
            a.strip_prefix("Bearer operator:")
                .or_else(|| a.strip_prefix("bearer operator:"))
                .map(str::to_string)
        });
    let provided = from_header.or(from_bearer);
    match provided {
        Some(t) if config::constant_time_eq(&t, &st.operator_token) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error":"operator_unauthorized",
                "hint":"X-OpenSesame-Operator or Bearer operator:<token> required"
            })),
        )
            .into_response()),
    }
}

#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn require_session_or_operator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(), Response> {
    if require_session(st, headers).is_ok() {
        return Ok(());
    }
    require_operator(st, headers)
}

/// Session subject when present; operator falls back to seeded `user:demo` (policy bootstrap).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn resolve_caller_subject(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<String, Response> {
    if let Ok((_, meta)) = require_session(st, headers) {
        return Ok(session_subject(&meta));
    }
    require_operator(st, headers)?;
    Ok("user:demo".into())
}

/// Which principal a request may act on behalf of.
///
/// Operators are unfenced. A session is fenced to the principal it was approved
/// as; a dev session that was never bound to a real principal id falls back to
/// the bootstrap principal, which is exactly the principal its invocations are
/// stamped with.
pub enum Caller {
    Operator,
    Session {
        subject: String,
        organization_id: opensesame_domain::OrganizationId,
        role: opensesame_domain::OrganizationRole,
    },
}

/// Parse the canonical Host principal spelling or Identity's public `prn_`
/// spelling into the one typed principal used by authorization records.
pub fn parse_principal(value: &str) -> Option<opensesame_domain::PrincipalId> {
    opensesame_domain::PrincipalId::parse(value)
        .ok()
        .or_else(|| {
            value
                .strip_prefix("prn_")
                .and_then(|id| opensesame_domain::PrincipalId::parse(id).ok())
        })
}

/// Compare principal subjects across the canonical Host spelling, Identity's
/// `prn_` spelling, and exact-match legacy subjects such as `user:demo`.
pub(crate) fn same_principal_subject(left: &str, right: &str) -> bool {
    match (parse_principal(left), parse_principal(right)) {
        (Some(left), Some(right)) => left == right,
        _ => left == right,
    }
}

impl Caller {
    pub fn owns_subject(&self, subject: &str) -> bool {
        match self {
            Caller::Operator => true,
            Caller::Session { subject: mine, .. } => mine == subject,
        }
    }

    pub fn owns(&self, principal: &opensesame_domain::PrincipalId) -> bool {
        match self {
            Caller::Operator => true,
            Caller::Session { subject, .. } => {
                let parsed = parse_principal(subject);
                parsed.as_ref() == Some(principal)
            }
        }
    }

    pub fn organization(
        &self,
        operator_default: opensesame_domain::OrganizationId,
    ) -> opensesame_domain::OrganizationId {
        match self {
            Caller::Operator => operator_default,
            Caller::Session {
                organization_id, ..
            } => *organization_id,
        }
    }

    pub fn in_organization(&self, organization_id: &opensesame_domain::OrganizationId) -> bool {
        match self {
            Caller::Operator => true,
            Caller::Session {
                organization_id: mine,
                ..
            } => mine == organization_id,
        }
    }

    pub fn can_configure_integrations(&self) -> bool {
        match self {
            Caller::Operator => true,
            Caller::Session { role, .. } => role.can_configure_integrations(),
        }
    }
}

/// Resolves the caller once: session first (fenced), operator second (unfenced).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn resolve_caller(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    if let Ok((_, meta)) = require_session(st, headers) {
        let subject = session_subject(&meta);
        let (organization_id, role) = session_organization(&meta).expect("require_session checked");
        return Ok(Caller::Session {
            subject,
            organization_id,
            role,
        });
    }
    require_operator(st, headers)?;
    Ok(Caller::Operator)
}

#[allow(clippy::result_large_err)]
pub fn require_demo_bootstrap(st: &AppState) -> Result<crate::app_state::Bootstrap, Response> {
    st.bootstrap
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"demo_bootstrap_unavailable","hint":"set OPENSESAME_DEV_BOOTSTRAP=true in non-production"})),
            )
                .into_response()
        })
}

#[cfg(test)]
mod tests {
    use super::{parse_principal, same_principal_subject, session_organization, Caller};
    use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
    use serde_json::json;

    #[test]
    fn session_organization_requires_a_typed_org_and_role() {
        let organization_id = OrganizationId::new();
        assert_eq!(
            session_organization(&json!({
                "organization_id": organization_id.to_string(),
                "organization_role": "admin",
            })),
            Some((organization_id, OrganizationRole::Admin))
        );
        assert!(session_organization(&json!({
            "organization_id": organization_id.to_string(),
        }))
        .is_none());
        assert!(session_organization(&json!({
            "organization_id": organization_id.to_string(),
            "organization_role": "operator",
        }))
        .is_none());
    }

    #[test]
    fn session_caller_keeps_tenant_and_role_while_operator_breaks_glass() {
        let principal = PrincipalId::new();
        let organization_id = OrganizationId::new();
        let session = Caller::Session {
            subject: principal.to_string(),
            organization_id,
            role: OrganizationRole::Member,
        };
        assert!(session.owns(&principal));
        assert!(session.owns_subject(&principal.to_string()));
        assert!(!session.owns_subject("prn_someone_else"));
        assert_eq!(session.organization(OrganizationId::new()), organization_id);
        assert!(session.in_organization(&organization_id));
        assert!(!session.in_organization(&OrganizationId::new()));
        assert!(!session.can_configure_integrations());

        let fallback = OrganizationId::new();
        assert!(Caller::Operator.owns(&PrincipalId::new()));
        assert!(Caller::Operator.owns_subject("prn_any_identity_subject"));
        assert_eq!(Caller::Operator.organization(fallback), fallback);
        assert!(Caller::Operator.in_organization(&OrganizationId::new()));
        assert!(Caller::Operator.can_configure_integrations());
    }

    #[test]
    fn identity_principal_spelling_maps_to_the_typed_host_id() {
        let principal = PrincipalId::new();
        assert_eq!(
            parse_principal(&format!("prn_{}", principal.as_uuid())),
            Some(principal)
        );
        let caller = Caller::Session {
            subject: format!("prn_{}", principal.as_uuid()),
            organization_id: OrganizationId::new(),
            role: OrganizationRole::Member,
        };

        assert!(caller.owns(&principal));
        assert!(!caller.owns_subject(&principal.to_string()));
        assert!(same_principal_subject(
            &format!("prn_{}", principal.as_uuid()),
            &principal.to_string()
        ));
        assert!(!caller.owns(&PrincipalId::new()));
    }
}
