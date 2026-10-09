//! Validated Host authority. Opaque bearer material is never a claim.
use chrono::{DateTime, Utc};
use opensesame_domain::{ActorId, OrganizationId, OrganizationRole, PrincipalId, ProjectId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Assurance {
    Anonymous,
    LocalUnverified,
    LocalUserPresence,
    Federated,
    Mfa,
    PhishingResistant,
}

#[derive(Clone)]
pub struct HostSessionClaims {
    pub credential_kind: CredentialKind,
    pub principal_id: PrincipalId,
    pub organization_id: OrganizationId,
    pub organization_role: OrganizationRole,
    pub client_id: String,
    pub audience: String,
    pub assurance: Assurance,
    pub auth_time: DateTime<Utc>,
    pub amr: Vec<String>,
    pub last_step_up_at: Option<DateTime<Utc>>,
    pub dpop_jkt: Option<String>,
    pub origin: Option<String>,
    pub capability_ceiling: Vec<String>,
    pub project_id: Option<ProjectId>,
    pub actor_id: Option<ActorId>,
    pub credential_handle: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub local_session: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    NativeSession,
    BrowserGrant,
    AgentCapability,
}

/// Canonical Host and Identity spellings resolve to the same principal.
pub fn parse_principal(value: &str) -> Option<PrincipalId> {
    PrincipalId::parse(value.strip_prefix("prn_").unwrap_or(value))
        .ok()
        .filter(|id| !id.as_uuid().is_nil())
}

impl HostSessionClaims {
    pub fn operator_approved(
        principal_id: PrincipalId,
        organization_id: OrganizationId,
        organization_role: OrganizationRole,
        client_id: String,
        audience: String,
    ) -> Self {
        let now = Utc::now();
        Self {
            credential_kind: CredentialKind::NativeSession,
            principal_id,
            organization_id,
            organization_role,
            client_id,
            audience,
            assurance: Assurance::LocalUnverified,
            auth_time: now,
            amr: vec!["operator_approval".into()],
            last_step_up_at: None,
            dpop_jkt: None,
            origin: None,
            capability_ceiling: vec!["host:user".into()],
            project_id: None,
            actor_id: None,
            credential_handle: None,
            issued_at: now,
            expires_at: now + chrono::Duration::minutes(5),
            local_session: false,
        }
    }
    /// Validation runs on every use, not merely at insertion.
    pub fn valid_for(&self, audience: &str, now: DateTime<Utc>) -> bool {
        !self.principal_id.as_uuid().is_nil()
            && (self.credential_kind == CredentialKind::BrowserGrant) == self.dpop_jkt.is_some()
            && !self.organization_id.as_uuid().is_nil()
            && !self.client_id.is_empty()
            && self.client_id.len() <= 256
            && self.audience == audience
            && !self.audience.is_empty()
            && self.issued_at <= now
            && self.auth_time <= now
            && self.auth_time <= self.issued_at
            && self.expires_at > now
            && self.expires_at > self.issued_at
            && !self.capability_ceiling.is_empty()
            && self.capability_ceiling.len() <= 64
            && self
                .capability_ceiling
                .iter()
                .all(|cap| !cap.is_empty() && cap.len() <= 128)
            && (!self.amr.is_empty()
                || (self.assurance == Assurance::LocalUnverified
                    && self
                        .capability_ceiling
                        .iter()
                        .all(|cap| cap == "host.sync.read")))
            && self.amr.len() <= 16
            && self
                .amr
                .iter()
                .all(|method| !method.is_empty() && method.len() <= 64)
            && self.origin.is_some() == self.dpop_jkt.is_some()
            && self.origin.as_ref().is_none_or(|origin| {
                url::Url::parse(origin).is_ok_and(|url| {
                    matches!(url.scheme(), "https" | "http")
                        && url.origin().ascii_serialization() == *origin
                })
            })
            && self.dpop_jkt.as_ref().is_none_or(|key| {
                key.len() == 43
                    && key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            && self.last_step_up_at.is_none_or(|at| {
                at <= now && at >= self.auth_time && self.assurance == Assurance::PhishingResistant
            })
    }

    /// Explicit public projection: no digest or raw bearer is serializable.
    pub fn public_view(&self) -> Value {
        json!({
            "principal_id": self.principal_id.to_string(),
            "approved_as": self.principal_id.to_string(),
            "organization_id": self.organization_id.to_string(),
            "organization_role": self.organization_role,
            "client_id": self.client_id,
            "audience": self.audience,
            "assurance": self.assurance,
            "auth_time": self.auth_time,
            "amr": self.amr,
            "last_step_up_at": self.last_step_up_at,
            "capability_ceiling": self.capability_ceiling,
            "project_id": self.project_id.map(|id| id.to_string()),
            "actor_id": self.actor_id.map(|id| id.to_string()),
            "credential_handle": self.credential_handle,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "local_session": self.local_session,
        })
    }
}

#[cfg(test)]
pub fn fixture(
    principal: PrincipalId,
    org: OrganizationId,
    role: OrganizationRole,
    audience: &str,
) -> HostSessionClaims {
    let now = Utc::now();
    HostSessionClaims {
        credential_kind: CredentialKind::NativeSession,
        principal_id: principal,
        organization_id: org,
        organization_role: role,
        client_id: "opensesame-cli".into(),
        audience: audience.into(),
        assurance: Assurance::LocalUnverified,
        auth_time: now,
        amr: vec!["operator_approval".into()],
        last_step_up_at: None,
        dpop_jkt: None,
        origin: None,
        capability_ceiling: vec!["host:user".into()],
        project_id: None,
        actor_id: None,
        credential_handle: None,
        issued_at: now,
        expires_at: now + chrono::Duration::minutes(5),
        local_session: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_or_expired_authority_is_rejected() {
        let valid = fixture(
            PrincipalId::new(),
            OrganizationId::new(),
            OrganizationRole::Member,
            "https://host.test",
        );
        assert!(valid.valid_for("https://host.test", Utc::now()));
        for mutate in [
            |s: &mut HostSessionClaims| s.capability_ceiling.clear(),
            |s: &mut HostSessionClaims| s.client_id.clear(),
            |s: &mut HostSessionClaims| s.audience.clear(),
            |s: &mut HostSessionClaims| s.amr.clear(),
            |s: &mut HostSessionClaims| s.expires_at = s.issued_at,
            |s: &mut HostSessionClaims| s.origin = Some("https://rp.test".into()),
            |s: &mut HostSessionClaims| s.principal_id = PrincipalId::from_uuid(uuid::Uuid::nil()),
        ] {
            let mut candidate = valid.clone();
            mutate(&mut candidate);
            assert!(!candidate.valid_for("https://host.test", Utc::now()));
        }
        assert!(!valid.valid_for("https://other.test", Utc::now()));
        assert!(parse_principal("user:demo").is_none());
    }

    #[test]
    fn projection_has_honest_assurance_and_no_token_or_digest_slot() {
        let claims = fixture(
            PrincipalId::new(),
            OrganizationId::new(),
            OrganizationRole::Owner,
            "https://host.test",
        );
        let view = claims.public_view();
        assert_eq!(view["assurance"], "local_unverified");
        for field in ["session_id", "session_digest", "access_token", "token"] {
            assert!(view.get(field).is_none());
        }
    }
}
