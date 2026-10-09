//! Authorization retained by a stream contains no bearer or reusable proof.
use crate::{
    app_state::AppState,
    middleware::auth::require_session,
    session_claims::{parse_principal, Assurance, CredentialKind, HostSessionClaims},
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde_json::json;

pub(super) struct StreamAuthority {
    digest: String,
    claims: HostSessionClaims,
}

impl StreamAuthority {
    pub(super) fn capture(st: &AppState, headers: &HeaderMap) -> Result<Self, Response> {
        let (digest, claims) = require_session(st, headers)?;
        Ok(Self { digest, claims })
    }

    /// Re-read authority before polling and before releasing buffered events.
    /// The initial request already consumed its `DPoP` proof; never replay it.
    pub(super) async fn active(&self, st: &AppState, run_id: &str) -> bool {
        let now = Utc::now();
        if !self.claims.valid_for(&st.resource, now) {
            return false;
        }
        let current = match self.claims.credential_kind {
            CredentialKind::BrowserGrant => {
                if let Some(claims) =
                    refreshed_browser_observe_claims(st, &self.digest, now.timestamp()).await
                {
                    claims
                } else {
                    return false;
                }
            }
            CredentialKind::NativeSession => {
                let Ok(sessions) = st.sessions.lock() else {
                    return false;
                };
                let Some(claims) = sessions.get(&self.digest).cloned() else {
                    return false;
                };
                claims
            }
            CredentialKind::AgentCapability => return false,
        };
        if !current.valid_for(&st.resource, now)
            || current.credential_kind != self.claims.credential_kind
            || current.principal_id != self.claims.principal_id
            || current.organization_id != self.claims.organization_id
            || current.client_id != self.claims.client_id
            || current.origin != self.claims.origin
            || current.dpop_jkt != self.claims.dpop_jkt
        {
            return false;
        }
        let Ok(Some(run)) = st
            .db
            .get_observation_run(&current.organization_id.to_string(), run_id)
            .await
        else {
            return false;
        };
        parse_principal(&run.owner_principal_id) == Some(current.principal_id)
    }
}

/// One-shot observe reads (`log`, `hook-records`, `get_run`) must meet the same
/// native membership and role-evidence floor as a live tail.
pub(super) async fn ensure_view_authority(st: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let (digest, claims) = require_session(st, headers)?;
    if claims.credential_kind != CredentialKind::BrowserGrant {
        return Ok(());
    }
    let now = Utc::now();
    if !claims.valid_for(&st.resource, now) {
        return Err(view_refused());
    }
    if refreshed_browser_observe_claims(st, &digest, now.timestamp())
        .await
        .is_none()
    {
        return Err(view_refused());
    }
    Ok(())
}

fn view_refused() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"}))).into_response()
}

async fn refreshed_browser_observe_claims(
    st: &AppState,
    digest: &str,
    now: i64,
) -> Option<HostSessionClaims> {
    let grant = st
        .db
        .browser_grant(digest, now)
        .await
        .ok()
        .flatten()?;
    let claims = super::super::browser_pairings::session_claims(&grant).ok()?;
    if claims.assurance != Assurance::PhishingResistant
        || claims.amr != ["webauthn"]
        || !claims
            .capability_ceiling
            .iter()
            .any(|cap| cap == "host.agent.observe")
    {
        return None;
    }
    let policy = opensesame_connection_broker::config_access::role_policy(
        st.db.pool(),
        &claims.organization_id,
        &claims.principal_id,
    )
    .await
    .ok()
    .flatten()?;
    if policy.role.is_none() || claims.auth_time.timestamp() <= policy.evidence_after {
        return None;
    }
    Some(claims)
}
