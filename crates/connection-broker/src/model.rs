//! Wire shapes for the connection broker HTTP contract.
//!
//! With one deliberate exception none of these structures has a field for
//! credential material, which is how the "no token crosses the API boundary"
//! invariant is kept by construction rather than by filtering. The exception is
//! [`DerivedMaterialization`] (ADR 0049): a provider-natively minted, short-lived,
//! revocable token, returned only when the connection's materialization policy is
//! `derived_short_lived`. The sealed stored credential never moves.

use opensesame_domain::{ConnectionOwnerKind, EgressBinding, MaterializationPolicy, Shareability};
use serde::{Deserialize, Serialize};

use crate::catalog::{Category, ConfigurationFieldDef, Provider, ScopeDef};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfiguredFieldView {
    pub name: String,
    pub hint: Option<String>,
}

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
    #[must_use]
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

    #[must_use]
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
    PolicyUpdated,
    Revoked,
    /// ADR 0049: a derived short-lived token was minted. Detail records the
    /// RFC 8693 mapping (subject = owning principal, actor = requesting
    /// caller), never token bytes.
    Materialized,
    /// ADR 0044: an offer over this connection was minted or claimed.
    Delegated,
    /// ADR 0044: a delegation of this connection was revoked.
    DelegationRevoked,
    /// ADR 0044: an offer burned — its token was seen again after spend, or
    /// the consent code was guessed at. Compromise evidence, not lapse.
    DelegationBurned,
    Error,
}

impl EventKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::AuthorizeStarted => "authorize_started",
            Self::Authorized => "authorized",
            Self::Refreshed => "refreshed",
            Self::RefreshFailed => "refresh_failed",
            Self::Bound => "bound",
            Self::Unbound => "unbound",
            Self::PolicyUpdated => "policy_updated",
            Self::Revoked => "revoked",
            Self::Materialized => "materialized",
            Self::Delegated => "delegated",
            Self::DelegationRevoked => "delegation_revoked",
            Self::DelegationBurned => "delegation_burned",
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
    Group,
    Device,
    Identity,
}

impl BindingTargetKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Organization => "organization",
            Self::Project => "project",
            Self::Agent => "agent",
            Self::Group => "group",
            Self::Device => "device",
            Self::Identity => "identity",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "organization" => Some(Self::Organization),
            "project" => Some(Self::Project),
            "agent" => Some(Self::Agent),
            "group" => Some(Self::Group),
            "device" => Some(Self::Device),
            "identity" => Some(Self::Identity),
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
    pub provenance_url: String,
    pub catalog_revision: String,
    pub auth_kind: String,
    pub supports_refresh: bool,
    pub configured: bool,
    pub auto_configurable: bool,
    pub callback_url: Option<String>,
    pub missing_config: Vec<String>,
    pub scopes: Vec<ScopeView>,
    pub egress: EgressView,
    pub operations: Vec<String>,
    pub integration_configuration_fields: Vec<ConfigurationFieldDef>,
    pub connection_configuration_fields: Vec<ConfigurationFieldDef>,
}

impl ProviderView {
    pub fn new(
        provider: &Provider,
        configured: bool,
        auto_configurable: bool,
        missing_config: Vec<String>,
        callback_url: Option<String>,
        catalog_revision: &str,
    ) -> Self {
        Self {
            id: provider.id.to_string(),
            display_name: provider.display_name.to_string(),
            category: provider.category,
            docs_url: provider.docs_url.to_string(),
            provenance_url: provider.provenance_url.to_string(),
            catalog_revision: catalog_revision.to_string(),
            auth_kind: provider.auth.kind().to_string(),
            supports_refresh: provider.auth.supports_refresh(),
            configured,
            auto_configurable,
            callback_url,
            missing_config,
            scopes: provider.scopes.iter().map(ScopeView::from).collect(),
            egress: EgressView::from(&provider.egress.binding()),
            operations: provider
                .operations
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
            integration_configuration_fields: provider.integration_configuration_fields().to_vec(),
            connection_configuration_fields: provider.connection_configuration_fields().to_vec(),
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
    pub integration_id: Option<String>,
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
    /// ADR 0049 policy gate for `POST /connections/{id}/mint`.
    pub materialization: MaterializationPolicy,
    pub requested_scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
    pub account_label: Option<String>,
    pub expires_at: Option<String>,
    pub refreshable: bool,
    pub configured_fields: Vec<ConfiguredFieldView>,
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

/// `POST /connections/{id}/mint` (ADR 0049). The one wire shape that carries
/// token bytes, and only ever provider-minted derived ones: short-lived,
/// installation/scope-attenuated, revocable at the provider. `subject` and
/// `actor` record the RFC 8693 mapping (ADR 0044): the connection's owning
/// principal acted upon, and the caller that asked.
#[derive(Clone, Debug, Serialize)]
pub struct DerivedMaterialization {
    pub connection_id: String,
    pub provider_id: String,
    /// Provider-native token kind, e.g. `github_app_installation`.
    pub kind: String,
    pub derived_token: String,
    pub expires_at: String,
    pub subject: String,
    pub actor: String,
    pub issued_at: String,
}

/// `POST /connections`.
#[derive(Clone, Debug)]
pub struct CreateConnection {
    pub provider_id: String,
    /// Required for new clients. Legacy callers may omit it only when exactly one
    /// usable integration exists for the selected provider.
    pub integration_id: Option<String>,
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
        for (name, kind) in [
            ("organization", BindingTargetKind::Organization),
            ("project", BindingTargetKind::Project),
            ("agent", BindingTargetKind::Agent),
            ("group", BindingTargetKind::Group),
            ("device", BindingTargetKind::Device),
            ("identity", BindingTargetKind::Identity),
        ] {
            assert_eq!(BindingTargetKind::parse(name), Some(kind));
        }
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
            EventKind::PolicyUpdated,
            EventKind::Revoked,
            EventKind::Materialized,
            EventKind::Delegated,
            EventKind::DelegationRevoked,
            EventKind::DelegationBurned,
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
                "policy_updated",
                "revoked",
                "materialized",
                "delegated",
                "delegation_revoked",
                "delegation_burned",
                "error"
            ]
        );
    }
}
