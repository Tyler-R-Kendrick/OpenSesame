//! Domain-scoped, metadata-only PAM lookup authorization (ADR 0213).
//!
//! A lookup grant names one origin. It never grants an inventory, another
//! origin, or access to an item's value; item use is a separate grant.

use crate::{DomainError, Grant};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

pub const PAM_DOMAIN_LOOKUP_ACTION: &str = "pam.domain.lookup";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PamDomainQuery {
    origin: String,
}

impl PamDomainQuery {
    /// # Errors
    /// Returns an error unless `origin` is an exact HTTPS or loopback HTTP origin.
    pub fn new(origin: &str) -> Result<Self, DomainError> {
        let parsed = Url::parse(origin)
            .map_err(|_| DomainError::GrantAttenuation("invalid PAM query origin".into()))?;
        let loopback = matches!(parsed.host_str(), Some("localhost" | "::1"))
            || parsed
                .host_str()
                .is_some_and(|host| host.starts_with("127."));
        if (parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
            || parsed.host_str().is_none()
        {
            return Err(DomainError::GrantAttenuation(
                "PAM query requires an exact origin".into(),
            ));
        }
        Ok(Self {
            origin: parsed.origin().ascii_serialization(),
        })
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    #[must_use]
    pub fn resource(&self) -> String {
        format!("pam:domain:{}", self.origin)
    }

    /// Check the query grant immediately before reading matching item metadata.
    /// # Errors
    /// Fails for an inactive grant, another action/resource, or export authority.
    pub fn authorize(
        &self,
        grant: &Grant,
        now: DateTime<Utc>,
    ) -> Result<PamLookupProof<'_>, DomainError> {
        grant.assert_active(now)?;
        if !grant.actions.iter().any(|a| a == PAM_DOMAIN_LOOKUP_ACTION)
            || !grant.permits_resource(&self.resource())
            || grant.constraints.raw_credential_export
        {
            return Err(DomainError::GrantAttenuation(
                "PAM lookup grant does not cover this origin".into(),
            ));
        }
        Ok(PamLookupProof { query: self })
    }
}

/// Proof returned only by the scoped grant check. It cannot be constructed outside this module.
#[derive(Clone, Copy, Debug)]
pub struct PamLookupProof<'a> {
    query: &'a PamDomainQuery,
}

impl<'a> PamLookupProof<'a> {
    #[must_use]
    pub fn origin(self) -> &'a str {
        self.query.origin()
    }
}

/// The complete return shape of a PAM domain lookup. Secret fields deliberately do not exist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PamItemMetadata {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub login_uris: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GrantConstraints, OfflineUse, OrganizationId, PrincipalId};
    use chrono::TimeZone;

    fn grant(actions: &[&str], resources: &[&str], export: bool) -> Grant {
        let now = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
        Grant {
            id: crate::GrantId::new(),
            version: 1,
            issuer_principal_id: PrincipalId::new(),
            beneficiary_principal_id: PrincipalId::new(),
            actor_id: None,
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::new(),
            project_id: None,
            environment_id: None,
            connection_id: None,
            actions: actions.iter().map(|value| (*value).to_string()).collect(),
            resources: resources.iter().map(|value| (*value).to_string()).collect(),
            constraints: GrantConstraints {
                audiences: vec![],
                not_before: None,
                expires_at: now + chrono::Duration::minutes(5),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: std::collections::BTreeMap::default(),
                maximum_delegation_depth: 0,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: export,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        }
    }

    #[test]
    fn exact_origin_gets_a_metadata_only_proof() {
        let now = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
        let query = PamDomainQuery::new("https://login.example.com").unwrap();
        let proof = query
            .authorize(
                &grant(&[PAM_DOMAIN_LOOKUP_ACTION], &[&query.resource()], false),
                now,
            )
            .unwrap();
        assert_eq!(proof.origin(), "https://login.example.com");
        let metadata = PamItemMetadata {
            id: "item".into(),
            name: "Example".into(),
            kind: "account".into(),
            login_uris: vec!["https://example.com".into()],
        };
        assert!(!serde_json::to_string(&metadata).unwrap().contains("secret"));
    }

    #[test]
    fn other_origins_actions_and_export_are_refused() {
        let now = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
        let query = PamDomainQuery::new("https://example.com").unwrap();
        for grant in [
            grant(
                &[PAM_DOMAIN_LOOKUP_ACTION],
                &["pam:domain:https://other.example"],
                false,
            ),
            grant(&["vault.items.read_meta"], &[&query.resource()], false),
            grant(&[PAM_DOMAIN_LOOKUP_ACTION], &[&query.resource()], true),
        ] {
            assert!(query.authorize(&grant, now).is_err());
        }
    }

    #[test]
    fn non_origins_and_credential_urls_are_refused() {
        for value in [
            "https://example.com/path",
            "https://user:pass@example.com",
            "https://example.com?next=other",
            "http://example.com",
            "example.com",
        ] {
            assert!(PamDomainQuery::new(value).is_err(), "accepted {value}");
        }
        assert!(PamDomainQuery::new("http://127.0.0.1:4173").is_ok());
    }

    #[test]
    fn expired_or_revoked_lookup_cannot_read_names() {
        let now = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
        let query = PamDomainQuery::new("https://example.com").unwrap();
        let mut expired = grant(&[PAM_DOMAIN_LOOKUP_ACTION], &[&query.resource()], false);
        expired.constraints.expires_at = now;
        assert!(query.authorize(&expired, now).is_err());
        let mut revoked = grant(&[PAM_DOMAIN_LOOKUP_ACTION], &[&query.resource()], false);
        revoked.revoked_at = Some(now);
        assert!(query.authorize(&revoked, now).is_err());
    }
}
