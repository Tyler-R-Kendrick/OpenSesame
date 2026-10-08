//! Authority handles: reference ≠ capability.
//!
//! Agents see [`ConnectionRef`]. Internal planes may use CredentialRef/KeyRef/SecretRef.
//! Possessing any handle never implies permission to resolve secret material.

use crate::{ConnectionId, CredentialHandleId, DomainError, OrganizationId, ProjectId};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable logical reference kinds under `AuthorityHandle`.
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

    #[must_use]
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
    #[must_use]
    pub fn knowledge_is_not_authorization(&self) -> bool {
        true
    }
}

impl fmt::Display for AuthorityHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.uri())
    }
}

/// Agent-facing connection reference (preferred over `SecretRef`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConnectionRef {
    pub handle: AuthorityHandle,
    pub connection_id: ConnectionId,
}

impl ConnectionRef {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
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
    /// Privileged compatibility — requires `raw_credential_export` grant.
    Resolve,
}

impl AuthorityOperation {
    #[must_use]
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
    /// Credential materialization / `SecretRef` resolve.
    Materialize = 3,
}

impl InvokeLevel {
    #[must_use]
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

#[path = "authority_egress.rs"]
mod authority_egress;

/// Mapping from `ConnectionRef` to optional internal `SecretRef` (never returned to agents).
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
    /// Opaque `ConnectionRef` / handle — Vault-aware apps.
    Handle,
    /// Federation / signer / SPIFFE — no credential in env.
    Native,
}

impl CredentialDeliveryMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Materialize => "materialize",
            Self::Placeholder => "placeholder",
            Self::Handle => "handle",
            Self::Native => "native",
        }
    }

    #[must_use]
    pub fn requires_export_privilege(self) -> bool {
        matches!(self, Self::Materialize)
    }
}

/// Where a projection declares its placeholder is presented on the wire.
///
/// Declarative only. Nothing substitutes a placeholder by searching request
/// text for it: the one admission rule is invoke-through's surrogate ledger
/// (ADR 0150 §2), which accepts a placeholder only as the entire value of its
/// declared site and places the credential itself. The rule set that used to
/// count appearances here was a second, divergent copy of that decision and
/// was retired with the L2 placeholder simulation (ADR 0150 §6.7).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PlaceholderLocation {
    Header { name: Option<String> },
    Path,
    Query { name: Option<String> },
    BodyField { path: String },
}

/// A projection's declared placement: the sites, methods and appearance
/// bound it was issued for. See [`PlaceholderLocation`] for where it is
/// enforced.
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

/// Project a `ConnectionRef` into a legacy env var shape for HTTP SDKs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyProjection {
    pub env_var: String,
    pub connection_ref_uri: String,
    /// Pattern hint, e.g. `ostest_*` or exact placeholder string.
    pub placeholder_pattern: String,
    /// The placeholder this projection actually handed out, when it is known.
    /// Substitution is bound to it exactly; the pattern only bounds shape.
    #[serde(default)]
    pub issued_placeholder: Option<String>,
    pub placement: PlaceholderPlacement,
    pub delivery: CredentialDeliveryMode,
}

impl LegacyProjection {
    /// Generate a unique shaped placeholder from pattern (`ostest_*` → `ostest_` + hex).
    ///
    /// The suffix is what makes a placeholder one connection's own. A pattern with
    /// no `*` used to be returned verbatim, which handed every projection sharing
    /// that pattern the same placeholder: egress substitution matches on the
    /// placeholder text, so identical placeholders mean one connection's request
    /// can be filled with another's credential. The suffix is appended instead.
    /// Shortest fill a `*` may stand for. A placeholder is a token the guest can
    /// see; substitution keys off its text, so a short one is guessable and a
    /// guessed one is a request the guest can have a credential written into.
    pub const MIN_PLACEHOLDER_FILL: usize = 8;

    /// Whether `placeholder` is one this projection could have issued.
    ///
    /// Substitution matches on placeholder text alone. Without this check a caller
    /// naming any string — `"a"`, or another connection's placeholder — has the
    /// real credential written wherever that string appears.
    #[must_use]
    pub fn accepts_placeholder(&self, placeholder: &str) -> bool {
        if placeholder.is_empty() {
            return false;
        }
        // When the issued placeholder is recorded, that one string is the whole
        // answer — the pattern is only a shape and several connections can share it.
        if let Some(issued) = &self.issued_placeholder {
            return placeholder == issued.as_str();
        }
        let pattern = self.placeholder_pattern.as_str();
        if pattern.is_empty() {
            return placeholder
                .strip_prefix("vlk_ph_")
                .is_some_and(|fill| fill.len() >= Self::MIN_PLACEHOLDER_FILL);
        }
        if !pattern.contains('*') {
            return placeholder
                .strip_prefix(pattern)
                .is_some_and(|fill| fill.len() >= Self::MIN_PLACEHOLDER_FILL);
        }
        let segments: Vec<&str> = pattern.split('*').collect();
        let last = segments.len() - 1;
        let mut rest = placeholder;
        for (i, seg) in segments.iter().enumerate() {
            if seg.is_empty() {
                continue;
            }
            if i == 0 {
                match rest.strip_prefix(seg) {
                    Some(r) => rest = r,
                    None => return false,
                }
            } else if i == last {
                match rest.strip_suffix(seg) {
                    Some(r) => rest = r,
                    None => return false,
                }
            } else {
                match rest.find(seg) {
                    Some(at) => rest = &rest[at + seg.len()..],
                    None => return false,
                }
            }
        }
        rest.len() >= Self::MIN_PLACEHOLDER_FILL
    }

    #[must_use]
    pub fn shaped_placeholder(&self, unique_suffix: &str) -> String {
        if self.placeholder_pattern.contains('*') {
            self.placeholder_pattern.replace('*', unique_suffix)
        } else if self.placeholder_pattern.is_empty() {
            format!("vlk_ph_{unique_suffix}")
        } else {
            format!("{}{unique_suffix}", self.placeholder_pattern)
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
    #[must_use]
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

    #[must_use]
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

    #[must_use]
    pub fn allows(&self, mode: CredentialDeliveryMode) -> bool {
        if self.deny.contains(&mode) {
            return false;
        }
        self.allow.is_empty() || self.allow.contains(&mode)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_allows(&self, mode: CredentialDeliveryMode) -> Result<(), DomainError> {
        if self.allows(mode) {
            Ok(())
        } else {
            Err(DomainError::ExportDenied)
        }
    }
}

impl ConnectionAuthorityBinding {
    /// Agent-visible surface: `ConnectionRef` only.
    #[must_use]
    pub fn agent_view(&self) -> ConnectionRef {
        self.connection_ref.clone()
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn resolve_secret_for_agent(&self) -> Result<AuthorityHandle, DomainError> {
        Err(DomainError::ExportDenied)
    }
}

#[cfg(test)]
#[path = "authority_egress_tests.rs"]
mod egress_tests;

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
            env_var: "WORKOS_API_KEY".into(),
            connection_ref_uri: "conn://demo/workos".into(),
            placeholder_pattern: "ostest_*".into(),
            issued_placeholder: None,
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        assert_eq!(lp.shaped_placeholder("abc"), "ostest_abc");

        // A pattern with no wildcard still gets the suffix. Returning it verbatim
        // gave every projection with that pattern one shared placeholder, and
        // substitution matches on placeholder text.
        let fixed = LegacyProjection {
            placeholder_pattern: "ostest".into(),
            ..lp.clone()
        };
        assert_eq!(fixed.shaped_placeholder("abc"), "ostestabc");
        let empty = LegacyProjection {
            placeholder_pattern: String::new(),
            ..lp
        };
        assert_eq!(empty.shaped_placeholder("abc"), "vlk_ph_abc");
    }

    #[test]
    fn a_projection_only_accepts_a_placeholder_it_could_have_issued() {
        let lp = LegacyProjection {
            env_var: "WORKOS_API_KEY".into(),
            connection_ref_uri: "conn://demo/workos".into(),
            placeholder_pattern: "ostest_*".into(),
            issued_placeholder: None,
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        assert!(lp.accepts_placeholder(&lp.shaped_placeholder("0123456789abcdef")));
        // Someone else's placeholder, a bare word, a short fill, or nothing at all.
        for bad in [
            "",
            "a",
            "Bearer ",
            "ostest_",
            "ostest_1",
            "oslive_0123456789abcdef",
        ] {
            assert!(!lp.accepts_placeholder(bad), "{bad} should not be accepted");
        }

        let unpatterned = LegacyProjection {
            placeholder_pattern: String::new(),
            ..lp
        };
        assert!(
            unpatterned.accepts_placeholder(&unpatterned.shaped_placeholder("0123456789abcdef"))
        );
        assert!(!unpatterned.accepts_placeholder("vlk_ph_1"));
    }

    #[test]
    fn a_recorded_placeholder_admits_only_itself() {
        let mine = LegacyProjection {
            env_var: "WORKOS_API_KEY".into(),
            connection_ref_uri: "conn://demo/workos".into(),
            placeholder_pattern: "ostest_*".into(),
            issued_placeholder: Some("ostest_0123456789abcdef".into()),
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        assert!(mine.accepts_placeholder("ostest_0123456789abcdef"));
        // Right shape, another connection's placeholder.
        assert!(!mine.accepts_placeholder("ostest_fedcba9876543210"));
        assert!(!mine.accepts_placeholder(""));
    }
}
