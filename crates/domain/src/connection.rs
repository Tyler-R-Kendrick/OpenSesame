use crate::{ConnectionId, OrganizationId, PrincipalId, ProjectId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionOwnerKind {
    Individual,
    Organization,
    Project,
    Service,
    Workload,
    Device,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shareability {
    Private,
    Delegable,
    OrganizationWide,
}

/// Whether a connection's authority may be materialized off the broker (ADR 0049).
/// Default deny: a provider-natively minted, short-lived, revocable derived token
/// is not credential material — the sealed stored credential never moves — but no
/// connection gets the carve-out without its owner opting in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterializationPolicy {
    #[default]
    Deny,
    DerivedShortLived,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnectionPolicy {
    pub owner_id: String,
    pub owner_kind: ConnectionOwnerKind,
    pub consent_subject_id: Option<PrincipalId>,
    pub shareability: Shareability,
    pub maximum_delegation_depth: u32,
    pub permitted_actor_kinds: Vec<String>,
    pub permitted_audiences: Vec<String>,
    pub raw_credential_export_allowed: bool,
    /// Absent in policies serialized before ADR 0049; absent means deny.
    #[serde(default)]
    pub materialization: MaterializationPolicy,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    pub id: ConnectionId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub connector_id: String,
    pub connector_version: String,
    pub component_digest: String,
    pub display_name: String,
    pub policy: ConnectionPolicy,
}

impl Connection {
    pub fn personal_oauth_is_not_org_shareable_by_default(policy: &ConnectionPolicy) -> bool {
        !(policy.owner_kind == ConnectionOwnerKind::Individual
            && policy.shareability == Shareability::OrganizationWide)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_grant_not_implicitly_org_wide() {
        let p = ConnectionPolicy {
            owner_id: "principal:x".into(),
            owner_kind: ConnectionOwnerKind::Individual,
            consent_subject_id: None,
            shareability: Shareability::Private,
            maximum_delegation_depth: 0,
            permitted_actor_kinds: vec!["human".into()],
            permitted_audiences: vec![],
            raw_credential_export_allowed: false,
            materialization: MaterializationPolicy::Deny,
        };
        assert!(Connection::personal_oauth_is_not_org_shareable_by_default(
            &p
        ));
    }

    #[test]
    fn materialization_defaults_to_deny_and_round_trips() {
        assert_eq!(
            MaterializationPolicy::default(),
            MaterializationPolicy::Deny
        );
        // Policies serialized before ADR 0049 carried no field; they parse as deny.
        let legacy = serde_json::json!({
            "owner_id": "principal:x",
            "owner_kind": "individual",
            "consent_subject_id": null,
            "shareability": "private",
            "maximum_delegation_depth": 0,
            "permitted_actor_kinds": ["human"],
            "permitted_audiences": [],
            "raw_credential_export_allowed": false
        });
        let parsed: ConnectionPolicy = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.materialization, MaterializationPolicy::Deny);
        assert_eq!(
            serde_json::to_value(MaterializationPolicy::DerivedShortLived).unwrap(),
            serde_json::Value::String("derived_short_lived".into())
        );
    }
}
