//! Wire shapes for the connection broker HTTP contract.
//!
//! These are the only structures the gateway serializes. None of them has a field
//! for credential material, which is how the "no token crosses the API boundary"
//! invariant is kept by construction rather than by filtering.

use opensesame_domain::{ConnectionOwnerKind, EgressBinding, Shareability};
use serde::{Deserialize, Serialize};

use crate::catalog::{configuration_fields, Category, ConfigurationFieldDef, Provider, ScopeDef};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Pending,
    Active,
    NeedsReauth,
    Expired,
    Revoked,
    Error,
}

impl ConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::NeedsReauth => "needs_reauth",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
            Self::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "active" => Self::Active,
            "needs_reauth" => Self::NeedsReauth,
            "expired" => Self::Expired,
            "revoked" => Self::Revoked,
            "error" => Self::Error,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Created,
    AuthorizeStarted,
    Authorized,
    Refreshed,
    RefreshFailed,
    Bound,
    Unbound,
    Revoked,
    Error,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::AuthorizeStarted => "authorize_started",
            Self::Authorized => "authorized",
            Self::Refreshed => "refreshed",
            Self::RefreshFailed => "refresh_failed",
            Self::Bound => "bound",
            Self::Unbound => "unbound",
            Self::Revoked => "revoked",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingTargetKind {
    Organization,
    Project,
    Agent,
}

impl BindingTargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Organization => "organization",
            Self::Project => "project",
            Self::Agent => "agent",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "organization" => Some(Self::Organization),
            "project" => Some(Self::Project),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EgressView {
    pub scheme: String,
    pub authorities: Vec<String>,
    pub path_prefixes: Vec<String>,
}

impl From<&EgressBinding> for EgressView {
    fn from(b: &EgressBinding) -> Self {
        Self {
            scheme: b.scheme.clone(),
            authorities: b.authorities.clone(),
            path_prefixes: b.path_prefixes.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ScopeView {
    pub name: String,
    pub description: String,
    pub sensitive: bool,
    pub default: bool,
}

impl From<&ScopeDef> for ScopeView {
    fn from(s: &ScopeDef) -> Self {
        Self {
            name: s.name.to_string(),
            description: s.description.to_string(),
            sensitive: s.sensitive,
            default: s.default,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderView {
    pub id: String,
    pub display_name: String,
    pub category: Category,
    pub docs_url: String,
    pub auth_kind: String,
    pub supports_refresh: bool,
    pub configured: bool,
    pub missing_config: Vec<String>,
    pub scopes: Vec<ScopeView>,
    pub egress: EgressView,
    pub operations: Vec<String>,
    pub configuration_fields: Vec<ConfigurationFieldDef>,
}

impl ProviderView {
    pub fn new(provider: &Provider, configured: bool, missing_config: Vec<String>) -> Self {
        Self {
            id: provider.id.to_string(),
            display_name: provider.display_name.to_string(),
            category: provider.category,
            docs_url: provider.docs_url.to_string(),
            auth_kind: provider.auth.kind().to_string(),
            supports_refresh: provider.auth.supports_refresh(),
            configured,
            missing_config,
            scopes: provider.scopes.iter().map(ScopeView::from).collect(),
            egress: EgressView::from(&provider.egress.binding()),
            operations: provider.operations.iter().map(|o| o.to_string()).collect(),
            configuration_fields: configuration_fields(provider.id).to_vec(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BindingView {
    pub id: String,
    pub target_kind: BindingTargetKind,
    pub target_id: String,
    pub target_label: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventView {
    pub id: String,
    pub kind: String,
    pub at: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConnectionView {
    pub connection_id: String,
    /// ADR 0005 URI. Always present: the agent surface is reference-only.
    pub connection_ref: String,
    pub logical_name: String,
    pub display_name: String,
    pub provider_id: String,
    pub status: ConnectionStatus,
    pub status_detail: Option<String>,
    pub organization_id: String,
    pub project_id: Option<String>,
    pub owner_kind: ConnectionOwnerKind,
    pub shareability: Shareability,
    pub requested_scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
    pub account_label: Option<String>,
    pub expires_at: Option<String>,
    pub refreshable: bool,
    pub last_refreshed_at: Option<String>,
    pub max_invoke_level: u8,
    pub egress: EgressView,
    pub bindings: Vec<BindingView>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthorizationStart {
    pub authorization_url: String,
    pub state: String,
    pub expires_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRevocation {
    Ok,
    Unsupported,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct RevokeOutcome {
    pub revoked: bool,
    pub provider_revocation: ProviderRevocation,
}

/// `POST /connections`.
#[derive(Clone, Debug)]
pub struct CreateConnection {
    pub provider_id: String,
    /// The caller this connection is being created for. Never read from a request
    /// body: the transport says who is asking, and only that may own the result.
    pub owner_subject: Option<String>,
    pub display_name: Option<String>,
    pub logical_name: Option<String>,
    pub project_id: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub shareability: Option<Shareability>,
}

/// `POST /connections/{id}/bindings`.
#[derive(Clone, Debug)]
pub struct BindRequest {
    pub target_kind: BindingTargetKind,
    pub target_id: String,
    pub target_label: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_vocabulary_round_trips() {
        for s in [
            ConnectionStatus::Pending,
            ConnectionStatus::Active,
            ConnectionStatus::NeedsReauth,
            ConnectionStatus::Expired,
            ConnectionStatus::Revoked,
            ConnectionStatus::Error,
        ] {
            assert_eq!(ConnectionStatus::parse(s.as_str()), s);
            assert_eq!(
                serde_json::to_value(s).unwrap(),
                serde_json::Value::String(s.as_str().into())
            );
        }
        assert_eq!(
            ConnectionStatus::parse("nonsense"),
            ConnectionStatus::Pending
        );
    }

    #[test]
    fn binding_target_kinds_are_closed() {
        assert_eq!(
            BindingTargetKind::parse("agent"),
            Some(BindingTargetKind::Agent)
        );
        assert!(BindingTargetKind::parse("everything").is_none());
    }

    #[test]
    fn event_kinds_match_the_contract() {
        let names: Vec<_> = [
            EventKind::Created,
            EventKind::AuthorizeStarted,
            EventKind::Authorized,
            EventKind::Refreshed,
            EventKind::RefreshFailed,
            EventKind::Bound,
            EventKind::Unbound,
            EventKind::Revoked,
            EventKind::Error,
        ]
        .iter()
        .map(|k| k.as_str())
        .collect();
        assert_eq!(
            names,
            vec![
                "created",
                "authorize_started",
                "authorized",
                "refreshed",
                "refresh_failed",
                "bound",
                "unbound",
                "revoked",
                "error"
            ]
        );
    }
}
