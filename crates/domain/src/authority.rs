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
                // A bare `starts_with` has no segment boundary, so an allowlisted
                // `/repos/foo` would also authorize `/repos/foo-private`.
                .any(|p| path == p || path.starts_with(&format!("{}/", p.trim_end_matches('/'))))
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

/// How many times `needle` occurs in `haystack`. An empty needle occurs nowhere:
/// `contains("")` is true of every string, and a substitution driven by it would
/// write the credential between every character.
fn occurrences(haystack: &str, needle: &str) -> u32 {
    if needle.is_empty() {
        return 0;
    }
    u32::try_from(haystack.matches(needle).count()).unwrap_or(u32::MAX)
}

/// Occurrences inside the values of the named query parameter only.
fn query_pair_occurrences(query: &str, name: &str, needle: &str) -> u32 {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == name).then_some(v)
        })
        .map(|v| occurrences(v, needle))
        .sum()
}

impl PlaceholderPlacement {
    /// Count occurrences of `placeholder` in the given request parts and enforce policy.
    ///
    /// Every site the placeholder appears at must be an allowed one, and the total
    /// number of appearances — not the number of request parts touched — is what
    /// `max_occurrences` bounds. Substitution replaces every occurrence, so counting
    /// parts let a caller multiply the credential inside one allowed header.
    pub fn assert_allowed(
        &self,
        req: &PlaceholderRequestView<'_>,
        placeholder: &str,
    ) -> Result<(), DomainError> {
        if placeholder.is_empty() {
            return Err(DomainError::GrantAttenuation(
                "empty placeholder is not substitutable".into(),
            ));
        }
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
        let mut denied_site: Option<&'static str> = None;

        if let (Some(hn), Some(hv)) = (req.header_name, req.header_value) {
            let found = occurrences(hv, placeholder);
            if found > 0 {
                hits += found;
                let allowed = self.locations.iter().any(|loc| {
                    matches!(loc, PlaceholderLocation::Header { name }
                        if name.as_ref().map(|n| n.eq_ignore_ascii_case(hn)).unwrap_or(true))
                });
                if !allowed {
                    denied_site = Some("header");
                }
            }
        }

        let in_path = occurrences(req.path, placeholder);
        if in_path > 0 {
            hits += in_path;
            if !self
                .locations
                .iter()
                .any(|l| matches!(l, PlaceholderLocation::Path))
            {
                denied_site = Some("path");
            }
        }

        if let Some(q) = req.query {
            let found = occurrences(q, placeholder);
            if found > 0 {
                hits += found;
                // A named query location covers its own parameter and nothing else,
                // so an appearance elsewhere in the query string is its own site.
                let covered: u32 = self
                    .locations
                    .iter()
                    .filter_map(|loc| match loc {
                        PlaceholderLocation::Query { name: None } => Some(found),
                        PlaceholderLocation::Query { name: Some(n) } => {
                            Some(query_pair_occurrences(q, n, placeholder))
                        }
                        _ => None,
                    })
                    .max()
                    .unwrap_or(0);
                if covered < found {
                    denied_site = Some("query");
                }
            }
        }

        if let (Some(fp), Some(fv)) = (req.body_field_path, req.body_field_value) {
            let found = occurrences(fv, placeholder);
            if found > 0 {
                hits += found;
                let allowed = self.locations.iter().any(
                    |loc| matches!(loc, PlaceholderLocation::BodyField { path: p } if p == fp),
                );
                if !allowed {
                    denied_site = Some("body field");
                }
            }
        }

        if hits == 0 {
            return Ok(());
        }
        if let Some(site) = denied_site {
            return Err(DomainError::GrantAttenuation(format!(
                "placeholder appeared outside allowed placement ({site})"
            )));
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
    /// The placeholder this projection actually handed out, when it is known.
    /// Substitution is bound to it exactly; the pattern only bounds shape.
    #[serde(default)]
    pub issued_placeholder: Option<String>,
    pub placement: PlaceholderPlacement,
    pub delivery: CredentialDeliveryMode,
}

impl LegacyProjection {
    /// Generate a unique shaped placeholder from pattern (`sk_test_*` → `sk_test_` + hex).
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
    fn path_prefixes_stop_at_a_segment_boundary() {
        let e = EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into()],
            path_prefixes: vec!["/repos/acme".into()],
            allow_redirects_cross_authority: false,
        };
        assert!(e.allows_url("https://api.github.com/repos/acme").is_ok());
        assert!(e
            .allows_url("https://api.github.com/repos/acme/catalog")
            .is_ok());
        // A bare prefix match let an attenuated grant reach a different owner.
        assert!(e
            .allows_url("https://api.github.com/repos/acme-private/secrets")
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
            issued_placeholder: None,
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        assert_eq!(lp.shaped_placeholder("abc"), "sk_test_abc");

        // A pattern with no wildcard still gets the suffix. Returning it verbatim
        // gave every projection with that pattern one shared placeholder, and
        // substitution matches on placeholder text.
        let fixed = LegacyProjection {
            placeholder_pattern: "sk_live".into(),
            ..lp.clone()
        };
        assert_eq!(fixed.shaped_placeholder("abc"), "sk_liveabc");
        let empty = LegacyProjection {
            placeholder_pattern: String::new(),
            ..lp
        };
        assert_eq!(empty.shaped_placeholder("abc"), "vlk_ph_abc");
    }

    #[test]
    fn a_projection_only_accepts_a_placeholder_it_could_have_issued() {
        let lp = LegacyProjection {
            env_var: "STRIPE_SECRET_KEY".into(),
            connection_ref_uri: "conn://demo/stripe".into(),
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
            env_var: "STRIPE_SECRET_KEY".into(),
            connection_ref_uri: "conn://demo/stripe".into(),
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

    #[test]
    fn placement_counts_every_appearance_not_every_part() {
        let p = PlaceholderPlacement::default();
        let ph = "ostest_0123456789abcdef";
        // One allowed header, but the credential would be written twice.
        let err = p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "POST",
                    header_name: Some("Authorization"),
                    header_value: Some(&format!("Bearer {ph} {ph}")),
                    ..Default::default()
                },
                ph,
            )
            .unwrap_err();
        assert!(format!("{err}").contains("max_occurrences"), "{err}");
    }

    #[test]
    fn placement_denies_a_second_site_even_beside_an_allowed_one() {
        let p = PlaceholderPlacement {
            max_occurrences: 4,
            ..PlaceholderPlacement::default()
        };
        let ph = "ostest_0123456789abcdef";
        let err = p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "POST",
                    header_name: Some("Authorization"),
                    header_value: Some(&format!("Bearer {ph}")),
                    query: Some(&format!("callback=https://evil.example/?t={ph}")),
                    ..Default::default()
                },
                ph,
            )
            .unwrap_err();
        assert!(
            format!("{err}").contains("outside allowed placement"),
            "{err}"
        );
    }

    #[test]
    fn a_named_query_location_covers_only_its_own_parameter() {
        let p = PlaceholderPlacement {
            locations: vec![PlaceholderLocation::Query {
                name: Some("key".into()),
            }],
            methods: vec!["GET".into()],
            max_occurrences: 1,
        };
        let ph = "ostest_0123456789abcdef";
        assert!(p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "GET",
                    query: Some(&format!("key={ph}")),
                    ..Default::default()
                },
                ph,
            )
            .is_ok());
        let err = p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "GET",
                    query: Some(&format!("redirect_uri=https://evil.example/?t={ph}")),
                    ..Default::default()
                },
                ph,
            )
            .unwrap_err();
        assert!(
            format!("{err}").contains("outside allowed placement"),
            "{err}"
        );
    }

    #[test]
    fn an_empty_placeholder_is_not_substitutable() {
        let p = PlaceholderPlacement::default();
        assert!(p
            .assert_allowed(
                &PlaceholderRequestView {
                    method: "POST",
                    header_name: Some("Authorization"),
                    header_value: Some("Bearer x"),
                    ..Default::default()
                },
                "",
            )
            .is_err());
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
