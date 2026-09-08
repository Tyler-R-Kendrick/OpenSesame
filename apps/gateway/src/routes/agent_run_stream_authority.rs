//! Authorization retained by a stream contains no bearer or reusable proof.
use crate::{
    app_state::AppState,
    middleware::auth::require_session,
    session_claims::{parse_principal, Assurance, CredentialKind, HostSessionClaims},
};
use axum::{http::HeaderMap, response::Response};
use chrono::Utc;

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
                let Ok(Some(grant)) = st.db.browser_grant(&self.digest, now.timestamp()).await
                else {
                    return false;
                };
                let Ok(claims) = super::super::browser_pairings::session_claims(&grant) else {
                    return false;
                };
                if claims.assurance != Assurance::PhishingResistant
                    || claims.amr != ["webauthn"]
                    || !claims
                        .capability_ceiling
                        .iter()
                        .any(|cap| cap == "host.agent.observe")
                {
                    return false;
                }
                let Ok(Some(policy)) = opensesame_connection_broker::config_access::role_policy(
                    st.db.pool(),
                    &claims.organization_id,
                    &claims.principal_id,
                )
                .await
                else {
                    return false;
                };
                if policy.role.is_none() || claims.auth_time.timestamp() <= policy.evidence_after {
                    return false;
                }
                claims
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
