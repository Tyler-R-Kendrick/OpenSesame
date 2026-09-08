use crate::app_state::AppState;
use crate::session_claims::HostSessionClaims;
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
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
) -> Result<(String, HostSessionClaims), Response> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .or_else(|| auth.strip_prefix("DPoP "))
    else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","hint":"Bearer opaque-session:<id> required"})),
        )
            .into_response());
    };
    let Some(session_id) = token
        .strip_prefix("opaque-session:")
        .or_else(|| token.strip_prefix("agent-capability:"))
    else {
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
    if !meta.valid_for(&st.resource, chrono::Utc::now()) {
        sessions.remove(&session_digest);
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session_claims"})),
        )
            .into_response());
    }
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let bound = meta.dpop_jkt.is_some();
    let agent = meta.credential_kind == crate::session_claims::CredentialKind::AgentCapability;
    if agent != token.starts_with("agent-capability:")
        || (agent && headers.contains_key("dpop"))
        || bound != auth.starts_with("DPoP ")
        || (bound && (origin != meta.origin.as_deref() || !headers.contains_key("dpop")))
        || (!bound && headers.contains_key(header::ORIGIN))
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid_session_claims"})),
        )
            .into_response());
    }
    Ok((session_digest, meta))
}

pub fn session_subject(meta: &HostSessionClaims) -> String {
    meta.principal_id.to_string()
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
    match opensesame_host_core::operator::check(&st.operator_token, headers) {
        Ok(()) => Ok(()),
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

/// A session has a typed subject. Local operator fixtures may select the explicitly created principal.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn resolve_caller_subject(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<String, Response> {
    if let Ok((_, meta)) = require_session(st, headers) {
        return Ok(session_subject(&meta));
    }
    require_operator(st, headers)?;
    Ok(require_demo_bootstrap(st)?.principal.to_string())
}

/// Which principal a request may act on behalf of.
///
/// Native operators select an organization explicitly. Every session carries
/// a validated canonical principal and organization; no identity fallback exists.
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
    crate::session_claims::parse_principal(value)
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

pub(crate) const OPERATOR_ORGANIZATION_HEADER: &str = "x-opensesame-organization";

/// Resolve the caller's organization without allowing a session to select a
/// different tenant. Operators may select an explicit canonical organization.
#[allow(clippy::result_large_err)]
pub fn resolve_caller_organization(
    st: &AppState,
    who: &Caller,
    headers: &axum::http::HeaderMap,
) -> Result<opensesame_domain::OrganizationId, Response> {
    let selected = headers.get(OPERATOR_ORGANIZATION_HEADER);
    match who {
        Caller::Operator => match selected {
            Some(raw) => match raw.to_str().ok().and_then(|value| {
                opensesame_domain::OrganizationId::parse(value)
                    .ok()
                    .filter(|id| id.to_string() == value)
            }) {
                Some(id) => Ok(id),
                None => Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_request","hint":"x-opensesame-organization must be a canonical organization id"})),
                )
                    .into_response()),
            },
            None => Ok(who.organization(st.connection_organization)),
        },
        Caller::Session { .. } => {
            if selected.is_some() {
                Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"forbidden","hint":"sessions cannot select an organization header"})),
                )
                    .into_response())
            } else {
                Ok(who.organization(st.connection_organization))
            }
        }
    }
}

/// Resolves the caller once: session first (fenced), operator second (unfenced).
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub fn resolve_caller(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    if let Ok((_, meta)) = require_session(st, headers) {
        let subject = session_subject(&meta);
        let (organization_id, role) = (meta.organization_id, meta.organization_role);
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
