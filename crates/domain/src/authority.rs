//! Authority handles: reference ≠ capability.
//!
//! Agents see [`ConnectionRef`]. Internal planes may use CredentialRef/KeyRef/SecretRef.
//! Possessing any handle never implies permission to resolve secret material.

use crate::{ConnectionId, CredentialHandleId, DomainError, OrganizationId, ProjectId};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable logical reference kinds under AuthorityHandle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKind {
    Connection,
    Credential,
    Key,
    CertificateAuthority,
    Signer,
    /// Internal compatibility only — never agent-facing by default.
    Secret,
}

/// Opaque authority handle. The URI form is informational; authorization is Grant+Intent.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AuthorityHandle {
    pub kind: AuthorityKind,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    /// Stable logical name within org/project (e.g. "github/main").
    pub logical_name: String,
    /// Optional immutable version for audit/rollback — agents should not need this.
    pub version: Option<u64>,
}

impl AuthorityHandle {
    pub fn connection(
        organization_id: OrganizationId,
        project_id: Option<ProjectId>,
        logical_name: impl Into<String>,
    ) -> Self {
        Self {
            kind: AuthorityKind::Connection,
            organization_id,
            project_id,
            logical_name: logical_name.into(),
            version: None,
        }
    }

    pub fn secret_internal(
        organization_id: OrganizationId,
        project_id: Option<ProjectId>,
        logical_name: impl Into<String>,
    ) -> Self {
        Self {
            kind: AuthorityKind::Secret,
            organization_id,
            project_id,
            logical_name: logical_name.into(),
            version: None,
        }
    }

    pub fn uri(&self) -> String {
        let scope = match &self.project_id {
            Some(p) => format!("{}/{}", self.organization_id, p),
            None => self.organization_id.to_string(),
        };
        let kind = match self.kind {
            AuthorityKind::Connection => "conn",
            AuthorityKind::Credential => "cred",
            AuthorityKind::Key => "key",
            AuthorityKind::CertificateAuthority => "ca",
            AuthorityKind::Signer => "signer",
            AuthorityKind::Secret => "secret",
        };
        match self.version {
            Some(v) => format!("{kind}://{scope}/{}@v{v}", self.logical_name),
            None => format!("{kind}://{scope}/{}", self.logical_name),
        }
    }

    /// Knowing a URI is harmless; it is not authorization.
    pub fn knowledge_is_not_authorization(&self) -> bool {
        true
    }
}

impl fmt::Display for AuthorityHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.uri())
    }
}

/// Agent-facing connection reference (preferred over SecretRef).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConnectionRef {
    pub handle: AuthorityHandle,
    pub connection_id: ConnectionId,
}

impl ConnectionRef {
    pub fn new(
        organization_id: OrganizationId,
        project_id: Option<ProjectId>,
        logical_name: impl Into<String>,
        connection_id: ConnectionId,
    ) -> Result<Self, DomainError> {
        let handle = AuthorityHandle::connection(organization_id, project_id, logical_name);
        if handle.kind != AuthorityKind::Connection {
            return Err(DomainError::InvalidId("connection ref".into()));
        }
        Ok(Self {
            handle,
            connection_id,
        })
    }
}

/// Privileged resolve/export request — Level 3 only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveAuthorityRequest {
    pub handle: AuthorityHandle,
    pub reason: String,
}

/// Operations on authority — resolve/read is the escape hatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityOperation {
    Describe,
    Authorize,
    Invoke,
    Sign,
    Encrypt,
    Decrypt,
    Mint,
    Lease,
    Exchange,
    Rotate,
    /// Privileged compatibility — requires raw_credential_export grant.
    Resolve,
}

impl AuthorityOperation {
    pub fn requires_export_privilege(self) -> bool {
        matches!(self, Self::Resolve)
    }
}

/// Invocation danger levels for agent APIs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvokeLevel {
    /// Typed connector operation (default).
    TypedOperation = 1,
    /// Constrained HTTP within connection egress allowlist.
    ConstrainedHttp = 2,
    /// Credential materialization / SecretRef resolve.
    Materialize = 3,
}

impl InvokeLevel {
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Egress binding for a connection — credential must not follow arbitrary destinations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressBinding {
    pub scheme: String,
    pub authorities: Vec<String>,
    /// Optional path prefixes allowed for L2 constrained HTTP.
    pub path_prefixes: Vec<String>,
    pub allow_redirects_cross_authority: bool,
}

impl Default for EgressBinding {
    fn default() -> Self {
        Self {
            scheme: "https".into(),
            authorities: vec![],
            path_prefixes: vec![],
            allow_redirects_cross_authority: false,
        }
    }
}

impl EgressBinding {
    pub fn allows_url(&self, url: &str) -> Result<(), DomainError> {
        let parsed = url::Url::parse(url).map_err(|_| DomainError::InvalidId("url".into()))?;
        if parsed.scheme() != self.scheme {
            return Err(DomainError::GrantAttenuation(format!(
                "scheme {} not allowed",
                parsed.scheme()
            )));
        }
        let host = parsed.host_str().unwrap_or_default();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let authority = if parsed.port().is_some() {
            format!("{host}:{port}")
        } else {
            host.to_string()
        };
        let ok = self.authorities.iter().any(|a| {
            a == &authority
                || a == host
                || (a.contains(':') && a.as_str() == format!("{host}:{port}"))
        });
        if !ok {
            return Err(DomainError::GrantAttenuation(format!(
                "authority {authority} not in egress allowlist"
            )));
        }
        if !self.path_prefixes.is_empty() {
            let path = parsed.path();
            if !self
                .path_prefixes
                .iter()
                .any(|p| path == p || path.starts_with(&format!("{p}/")) || path.starts_with(p))
            {
                return Err(DomainError::GrantAttenuation(
                    "path not in egress allowlist".into(),
                ));
            }
        }
        // Never allow credential-bearing userinfo
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(DomainError::GrantAttenuation("userinfo URLs denied".into()));
        }
        Ok(())
    }

    /// Authenticated redirects must not cross authority unless explicitly allowed.
    pub fn allows_redirect(&self, from_url: &str, to_url: &str) -> Result<(), DomainError> {
        self.allows_url(from_url)?;
        if self.allow_redirects_cross_authority {
            return self.allows_url(to_url);
        }
        let from = url::Url::parse(from_url).map_err(|_| DomainError::InvalidId("url".into()))?;
        let to = url::Url::parse(to_url).map_err(|_| DomainError::InvalidId("url".into()))?;
        let from_host = from.host_str().unwrap_or_default();
        let to_host = to.host_str().unwrap_or_default();
        if from_host != to_host {
            return Err(DomainError::GrantAttenuation(
                "cross-authority redirect denied while holding credential".into(),
            ));
        }
        self.allows_url(to_url)
    }
}

/// Mapping from ConnectionRef to optional internal SecretRef (never returned to agents).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionAuthorityBinding {
    pub connection_ref: ConnectionRef,
    pub internal_secret: Option<AuthorityHandle>,
    pub credential_handle: Option<CredentialHandleId>,
    pub egress: EgressBinding,
    pub max_invoke_level: InvokeLevel,
}

/// How a credential/authority is delivered into a developer or agent process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialDeliveryMode {
    /// Real secret in environment — legacy escape hatch.
    Materialize,
    /// Shaped fake value; real secret only at placement-bound egress.
    Placeholder,
    /// Opaque ConnectionRef / handle — Vault-aware apps.
    Handle,
    /// Federation / signer / SPIFFE — no credential in env.
    Native,
}

impl CredentialDeliveryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Materialize => "materialize",
            Self::Placeholder => "placeholder",
            Self::Handle => "handle",
            Self::Native => "native",
        }
    }

    pub fn requires_export_privilege(self) -> bool {
        matches!(self, Self::Materialize)
    }
}

/// Where a placeholder may be substituted on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PlaceholderLocation {
    Header { name: Option<String> },
    Path,
    Query { name: Option<String> },
    BodyField { path: String },
}

/// Placement policy for placeholder substitution — fail closed outside these rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceholderPlacement {
    pub locations: Vec<PlaceholderLocation>,
    pub methods: Vec<String>,
    pub max_occurrences: u32,
}

impl Default for PlaceholderPlacement {
    fn default() -> Self {
        Self {
            locations: vec![PlaceholderLocation::Header {
                name: Some("Authorization".into()),
            }],
            methods: vec!["GET".into(), "POST".into(), "PUT".into(), "PATCH".into()],
            max_occurrences: 1,
        }
    }
}

/// Request fragments inspected when enforcing placeholder placement.
#[derive(Clone, Debug, Default)]
pub struct PlaceholderRequestView<'a> {
    pub method: &'a str,
    pub header_name: Option<&'a str>,
    pub header_value: Option<&'a str>,
    pub path: &'a str,
    pub query: Option<&'a str>,
    pub body_field_path: Option<&'a str>,
    pub body_field_value: Option<&'a str>,
}

impl PlaceholderPlacement {
    /// Count occurrences of `placeholder` in the given request parts and enforce policy.
    pub fn assert_allowed(
        &self,
        req: &PlaceholderRequestView<'_>,
        placeholder: &str,
    ) -> Result<(), DomainError> {
        let method_ok = self
            .methods
            .iter()
            .any(|m| m.eq_ignore_ascii_case(req.method));
        if !method_ok {
            return Err(DomainError::GrantAttenuation(format!(
                "method {} not allowed for placeholder substitution",
                req.method
            )));
        }

        let mut hits = 0u32;
        let mut allowed_hit = false;

        if let (Some(hn), Some(hv)) = (req.header_name, req.header_value) {
            let in_header = hv.contains(placeholder);
            if in_header {
                hits += 1;
                for loc in &self.locations {
                    if let PlaceholderLocation::Header { name } = loc {
                        if name
                            .as_ref()
                            .map(|n| n.eq_ignore_ascii_case(hn))
                            .unwrap_or(true)
                        {
                            allowed_hit = true;
                        }
                    }
                }
            }
        }

        if req.path.contains(placeholder) {
            hits += 1;
            if self
                .locations
                .iter()
                .any(|l| matches!(l, PlaceholderLocation::Path))
            {
                allowed_hit = true;
            }
        }

        if let Some(q) = req.query {
            if q.contains(placeholder) {
                hits += 1;
                for loc in &self.locations {
                    if let PlaceholderLocation::Query { name } = loc {
                        if name.is_none() || q.contains(placeholder) {
                            allowed_hit = true;
                        }
                    }
                }
            }
        }

        if let (Some(fp), Some(fv)) = (req.body_field_path, req.body_field_value) {
            if fv.contains(placeholder) {
                hits += 1;
                for loc in &self.locations {
                    if let PlaceholderLocation::BodyField { path: p } = loc {
                        if p == fp {
                            allowed_hit = true;
                        }
                    }
                }
            }
        }

        if hits == 0 {
            return Ok(());
        }
        if !allowed_hit {
            return Err(DomainError::GrantAttenuation(
                "placeholder appeared outside allowed placement".into(),
            ));
        }
        if hits > self.max_occurrences {
            return Err(DomainError::GrantAttenuation(format!(
                "placeholder exceeded max_occurrences {}",
                self.max_occurrences
            )));
        }
        Ok(())
    }
}

/// Project a ConnectionRef into a legacy env var shape for HTTP SDKs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyProjection {
    pub env_var: String,
    pub connection_ref_uri: String,
    /// Pattern hint, e.g. `sk_test_*` or exact placeholder string.
    pub placeholder_pattern: String,
    pub placement: PlaceholderPlacement,
    pub delivery: CredentialDeliveryMode,
}

impl LegacyProjection {
    /// Generate a unique shaped placeholder from pattern (`sk_test_*` → `sk_test_` + hex).
    pub fn shaped_placeholder(&self, unique_suffix: &str) -> String {
        if self.placeholder_pattern.contains('*') {
            self.placeholder_pattern.replace('*', unique_suffix)
        } else if self.placeholder_pattern.is_empty() {
            format!("vlk_ph_{unique_suffix}")
        } else {
            self.placeholder_pattern.clone()
        }
    }
}

/// Project / agent delivery policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevDeliveryPolicy {
    pub allow: Vec<CredentialDeliveryMode>,
    pub deny: Vec<CredentialDeliveryMode>,
}

impl DevDeliveryPolicy {
    pub fn development_default() -> Self {
        Self {
            allow: vec![
                CredentialDeliveryMode::Placeholder,
                CredentialDeliveryMode::Handle,
                CredentialDeliveryMode::Native,
            ],
            deny: vec![CredentialDeliveryMode::Materialize],
        }
    }

    pub fn agent_default() -> Self {
        Self {
            allow: vec![
                CredentialDeliveryMode::Handle,
                CredentialDeliveryMode::Native,
                CredentialDeliveryMode::Placeholder,
            ],
            deny: vec![CredentialDeliveryMode::Materialize],
        }
    }

    pub fn allows(&self, mode: CredentialDeliveryMode) -> bool {
        if self.deny.contains(&mode) {
            return false;
        }
        self.allow.is_empty() || self.allow.contains(&mode)
    }

    pub fn assert_allows(&self, mode: CredentialDeliveryMode) -> Result<(), DomainError> {
        if self.allows(mode) {
            Ok(())
        } else {
            Err(DomainError::ExportDenied)
        }
    }
}

impl ConnectionAuthorityBinding {
    /// Agent-visible surface: ConnectionRef only.
    pub fn agent_view(&self) -> ConnectionRef {
        self.connection_ref.clone()
    }

    pub fn resolve_secret_for_agent(&self) -> Result<AuthorityHandle, DomainError> {
        Err(DomainError::ExportDenied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_uri_stable_without_version() {
        let org = OrganizationId::new();
        let h = AuthorityHandle::connection(org, None, "github/main");
        assert!(h.uri().starts_with("conn://"));
        assert!(h.uri().contains("github/main"));
        assert!(!h.uri().contains("@v"));
    }

    #[test]
    fn secret_uri_is_internal_kind() {
        let h =
            AuthorityHandle::secret_internal(OrganizationId::new(), None, "github/legacy-token");
        assert_eq!(h.kind, AuthorityKind::Secret);
        assert!(h.uri().starts_with("secret://"));
    }

    #[test]
    fn resolve_denied_by_default_on_binding() {
        let org = OrganizationId::new();
        let cid = ConnectionId::new();
        let cref = ConnectionRef::new(org, None, "github/main", cid).unwrap();
        let binding = ConnectionAuthorityBinding {
            connection_ref: cref,
            internal_secret: Some(AuthorityHandle::secret_internal(
                org,
                None,
                "github/legacy-token",
            )),
            credential_handle: None,
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec!["api.github.com".into()],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
            max_invoke_level: InvokeLevel::TypedOperation,
        };
        assert!(binding.resolve_secret_for_agent().is_err());
        assert_eq!(binding.agent_view().handle.kind, AuthorityKind::Connection);
    }

    #[test]
    fn egress_blocks_evil_destination() {
        let e = EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into()],
            path_prefixes: vec!["/repos/".into()],
            allow_redirects_cross_authority: false,
        };
        assert!(e
            .allows_url("https://api.github.com/repos/acme/x/pulls")
            .is_ok());
        assert!(e.allows_url("https://evil.example/foo").is_err());
        assert!(e
            .allows_redirect(
                "https://api.github.com/repos/x",
                "https://evil.example/steal"
            )
            .is_err());
        assert!(e
            .allows_url("https://user:pass@api.github.com/repos/x")
            .is_err());
    }

    #[test]
    fn invoke_levels_ordered() {
        assert!(InvokeLevel::TypedOperation < InvokeLevel::ConstrainedHttp);
        assert!(InvokeLevel::ConstrainedHttp < InvokeLevel::Materialize);
        assert!(AuthorityOperation::Resolve.requires_export_privilege());
        assert!(!AuthorityOperation::Invoke.requires_export_privilege());
    }

    #[test]
    fn knowledge_of_ref_is_not_authz() {
        let h = AuthorityHandle::connection(OrganizationId::new(), None, "x");
        assert!(h.knowledge_is_not_authorization());
    }

    #[test]
    fn agent_policy_denies_materialize() {
        let p = DevDeliveryPolicy::agent_default();
        assert!(!p.allows(CredentialDeliveryMode::Materialize));
        assert!(p.allows(CredentialDeliveryMode::Placeholder));
        assert!(p
            .assert_allows(CredentialDeliveryMode::Materialize)
            .is_err());
    }

    #[test]
    fn shaped_placeholder_from_pattern() {
        let lp = LegacyProjection {
            env_var: "STRIPE_SECRET_KEY".into(),
            connection_ref_uri: "conn://demo/stripe".into(),
            placeholder_pattern: "sk_test_*".into(),
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        assert_eq!(lp.shaped_placeholder("abc"), "sk_test_abc");
    }

    #[test]
    fn placement_denies_body_when_only_header_allowed() {
        let p = PlaceholderPlacement::default();
        assert!(p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "POST",
                    header_name: Some("Authorization"),
                    header_value: Some("Bearer sk_test_x"),
                    path: "/v1/charges",
                    query: None,
                    body_field_path: None,
                    body_field_value: None,
                },
                "sk_test_x",
            )
            .is_ok());
        assert!(p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "POST",
                    header_name: None,
                    header_value: None,
                    path: "/v1/charges",
                    query: None,
                    body_field_path: Some("message"),
                    body_field_value: Some("leak sk_test_x"),
                },
                "sk_test_x",
            )
            .is_err());
    }
}
