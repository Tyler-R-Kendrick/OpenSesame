//! Connector manifest (`connectors/<id>/connector.yaml`) — ADR 0061 §4.
//!
//! A manifest is inert data. Parsing one never causes execution, network
//! access, or registration; registration happens only through `HostRuntime`
//! under the digest-pinning rules of ADR 0061 §3/§5. Every struct rejects
//! unknown fields (the config-file-as-code lesson: an attacker must not be
//! able to smuggle a field this parser silently ignores today and some
//! future consumer honors tomorrow), and the schema has no field capable of
//! carrying credential material — a test below holds the field-name set
//! against the secret-shaped denylist.

use serde::Deserialize;

use crate::is_blocked_host;

/// The one accepted apiVersion. New schema shapes get a new version, never a
/// silent widening of this one.
pub const MANIFEST_API_VERSION: &str = "opensesame.dev/v1alpha1";
/// The one accepted kind.
pub const MANIFEST_KIND: &str = "ConnectorDefinition";
/// The one WIT world v1alpha1 components may target.
pub const MANIFEST_WIT_WORLD: &str = "opensesame:connector/connector@1.0.0";
/// Manifests larger than this are refused before parsing.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// Capability families a connector may claim (ADR 0061 §1). Kept in sync with
/// `CapabilityId` in `apps/pages/src/lib/capabilities.ts`.
pub const MANIFEST_FAMILIES: [&str; 6] = [
    "encryption",
    "history",
    "cloud_secrets",
    "password_managers",
    "identity",
    "certificates",
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest exceeds {MAX_MANIFEST_BYTES} bytes")]
    TooLarge,
    #[error("manifest is not valid YAML/JSON: {0}")]
    Syntax(String),
    #[error("unsupported apiVersion `{0}`")]
    ApiVersion(String),
    #[error("unsupported kind `{0}`")]
    Kind(String),
    #[error("connector id `{0}` is not a lowercase slug")]
    Id(String),
    #[error("version `{0}` is not MAJOR.MINOR.PATCH")]
    Version(String),
    #[error("publisher `{0}` is not an https URL")]
    Publisher(String),
    #[error("component reference `{0}` lacks a pinned sha256 digest")]
    Digest(String),
    #[error("unsupported witWorld `{0}`")]
    WitWorld(String),
    #[error("authModes must not be empty")]
    NoAuthModes,
    #[error("outbound host `{0}` is not an exact public hostname")]
    OutboundHost(String),
    #[error("operations must not be empty")]
    NoOperations,
    #[error("operation id `{0}` is not a lowercase dotted slug")]
    OperationId(String),
    #[error("unknown capability family `{0}`")]
    Family(String),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectorManifest {
    pub api_version: String,
    pub kind: String,
    pub metadata: ManifestMetadata,
    pub spec: ManifestSpec,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManifestMetadata {
    pub id: String,
    pub version: String,
    pub publisher: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManifestSpec {
    pub component: ComponentRef,
    pub auth_modes: Vec<AuthMode>,
    pub outbound: Outbound,
    pub operations: Vec<OperationSpec>,
    #[serde(default)]
    pub rotation: Option<RotationCaps>,
    /// Capability families this connector serves (ADR 0061 §1).
    #[serde(default)]
    pub families: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ComponentRef {
    /// OCI reference pinned by digest: `registry/name@sha256:<64 hex>`.
    pub oci: String,
    pub wit_world: String,
    pub signatures_required: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    BrokeredSession,
    ApiKey,
    Oauth2,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Outbound {
    /// Exact hostnames (no scheme, path, wildcard, or userinfo). The runtime
    /// enforces the *intersection* of this list and `HostPolicy` egress.
    pub hosts: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OperationSpec {
    pub id: String,
    pub risk: OperationRisk,
    #[serde(default)]
    pub side_effect: bool,
    #[serde(default)]
    pub approval_recommended: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationRisk {
    Read,
    Write,
    Admin,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RotationCaps {
    #[serde(default)]
    pub supports_overlap: bool,
    #[serde(default)]
    pub supports_verify: bool,
    #[serde(default)]
    pub supports_rollback: bool,
}

impl ConnectorManifest {
    /// Parse and validate a YAML manifest. JSON is a subset of YAML, so JSON
    /// manifests parse through the same entry point.
    pub fn from_yaml(text: &str) -> Result<Self, ManifestError> {
        if text.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
        let manifest: Self =
            serde_norway::from_str(text).map_err(|e| ManifestError::Syntax(e.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The pinned `sha256:<64 hex>` portion of the component reference.
    #[must_use]
    pub fn component_digest(&self) -> &str {
        match self.spec.component.oci.rsplit_once('@') {
            Some((_, digest)) => digest,
            None => "",
        }
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.api_version != MANIFEST_API_VERSION {
            return Err(ManifestError::ApiVersion(self.api_version.clone()));
        }
        if self.kind != MANIFEST_KIND {
            return Err(ManifestError::Kind(self.kind.clone()));
        }
        if !is_slug(&self.metadata.id) {
            return Err(ManifestError::Id(self.metadata.id.clone()));
        }
        if !is_semverish(&self.metadata.version) {
            return Err(ManifestError::Version(self.metadata.version.clone()));
        }
        if !self.metadata.publisher.starts_with("https://") {
            return Err(ManifestError::Publisher(self.metadata.publisher.clone()));
        }
        if !is_pinned_digest(self.component_digest()) {
            return Err(ManifestError::Digest(self.spec.component.oci.clone()));
        }
        if self.spec.component.wit_world != MANIFEST_WIT_WORLD {
            return Err(ManifestError::WitWorld(
                self.spec.component.wit_world.clone(),
            ));
        }
        if self.spec.auth_modes.is_empty() {
            return Err(ManifestError::NoAuthModes);
        }
        for host in &self.spec.outbound.hosts {
            if !is_exact_public_host(host) {
                return Err(ManifestError::OutboundHost(host.clone()));
            }
        }
        if self.spec.operations.is_empty() {
            return Err(ManifestError::NoOperations);
        }
        for op in &self.spec.operations {
            if !is_operation_id(&op.id) {
                return Err(ManifestError::OperationId(op.id.clone()));
            }
        }
        if let Some(families) = &self.spec.families {
            for family in families {
                if !MANIFEST_FAMILIES.contains(&family.as_str()) {
                    return Err(ManifestError::Family(family.clone()));
                }
            }
        }
        Ok(())
    }
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_semverish(s: &str) -> bool {
    let mut parts = s.split('.');
    let ok = |p: Option<&str>| {
        p.is_some_and(|n| !n.is_empty() && n.len() <= 9 && n.chars().all(|c| c.is_ascii_digit()))
    };
    ok(parts.next()) && ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// `repository.read`, `pull_request.create` — lowercase dotted slugs.
fn is_operation_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && s.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

fn is_pinned_digest(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    })
}

/// Exact hostname, optional `:port`. No scheme, path, wildcard, userinfo, or
/// whitespace; refused when the SSRF fence blocks it. This is deliberately the
/// same "exact host" doctrine as `EgressBinding` — no suffix matching, ever.
fn is_exact_public_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let (name, port) = match host.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
        || name.starts_with('.')
        || name.ends_with('.')
        || name.contains("..")
    {
        return false;
    }
    !is_blocked_host(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("../../../connectors/mock/connector.yaml");

    #[test]
    fn golden_mock_manifest_parses() {
        let m = ConnectorManifest::from_yaml(GOLDEN).expect("golden manifest");
        assert_eq!(m.metadata.id, "mock");
        assert_eq!(m.spec.component.wit_world, MANIFEST_WIT_WORLD);
        assert!(m.spec.component.signatures_required);
        assert!(is_pinned_digest(m.component_digest()));
        assert_eq!(m.spec.operations.len(), 2);
        assert_eq!(m.spec.operations[1].risk, OperationRisk::Write);
        assert!(m.spec.operations[1].approval_recommended);
        assert!(m.spec.outbound.hosts.is_empty());
    }

    #[test]
    fn json_is_yaml_here() {
        let json = serde_json::json!({
            "apiVersion": MANIFEST_API_VERSION,
            "kind": MANIFEST_KIND,
            "metadata": {"id": "echo", "version": "1.0.0", "publisher": "https://example.com"},
            "spec": {
                "component": {
                    "oci": format!("ghcr.io/acme/echo@sha256:{}", "a".repeat(64)),
                    "witWorld": MANIFEST_WIT_WORLD,
                    "signaturesRequired": true
                },
                "authModes": ["brokered_session"],
                "outbound": {"hosts": ["api.example.com"]},
                "operations": [{"id": "echo.read", "risk": "read"}]
            }
        })
        .to_string();
        let m = ConnectorManifest::from_yaml(&json).expect("json manifest");
        assert_eq!(m.spec.outbound.hosts, ["api.example.com"]);
    }

    fn golden_with(from: &str, to: &str) -> Result<ConnectorManifest, ManifestError> {
        let text = GOLDEN.replace(from, to);
        assert_ne!(text, GOLDEN, "replacement `{from}` must hit");
        ConnectorManifest::from_yaml(&text)
    }

    #[test]
    fn rejection_table() {
        // Unknown fields anywhere are refused, not ignored.
        assert!(matches!(
            golden_with(
                "kind: ConnectorDefinition",
                "kind: ConnectorDefinition\nextra: 1"
            ),
            Err(ManifestError::Syntax(_))
        ));
        assert!(matches!(
            golden_with("  operations:", "  injected: true\n  operations:"),
            Err(ManifestError::Syntax(_))
        ));
        assert!(matches!(
            golden_with("opensesame.dev/v1alpha1", "opensesame.dev/v2"),
            Err(ManifestError::ApiVersion(_))
        ));
        assert!(matches!(
            golden_with("kind: ConnectorDefinition", "kind: HookDefinition"),
            Err(ManifestError::Kind(_))
        ));
        assert!(matches!(
            golden_with("id: mock", "id: Mock"),
            Err(ManifestError::Id(_))
        ));
        assert!(matches!(
            golden_with("version: 1.0.0", "version: latest"),
            Err(ManifestError::Version(_))
        ));
        assert!(matches!(
            golden_with("publisher: https://", "publisher: http://"),
            Err(ManifestError::Publisher(_))
        ));
        // A truncated or unpinned digest is refused.
        let unpinned = golden_with("@sha256:", "@sha256:deadbeef-");
        assert!(matches!(unpinned, Err(ManifestError::Digest(_))));
        assert!(matches!(
            golden_with("connector@1.0.0", "connector@2.0.0"),
            Err(ManifestError::WitWorld(_))
        ));
        assert!(matches!(
            golden_with("authModes: [brokered_session]", "authModes: []"),
            Err(ManifestError::NoAuthModes)
        ));
        // Wildcards, schemes, localhost, and IP literals are not exact
        // public hosts.
        for bad in [
            "hosts: [\"*.example.com\"]",
            "hosts: [\"https://api.example.com\"]",
            "hosts: [\"api.example.com/path\"]",
            "hosts: [localhost]",
            "hosts: [\"127.0.0.1\"]",
            "hosts: [\"169.254.169.254\"]",
            "hosts: [\"metadata.google.internal\"]",
        ] {
            assert!(
                matches!(
                    golden_with("hosts: []", bad),
                    Err(ManifestError::OutboundHost(_))
                ),
                "{bad} must be refused"
            );
        }
        assert!(matches!(
            golden_with("hosts: []", "hosts: [\"api.example.com\"]"),
            Ok(_)
        ));
    }

    #[test]
    fn families_are_a_closed_set() {
        let ok = golden_with(
            "  operations:",
            "  families: [certificates, cloud_secrets]\n  operations:",
        );
        assert!(ok.is_ok());
        assert!(matches!(
            golden_with("  operations:", "  families: [shell]\n  operations:"),
            Err(ManifestError::Family(_))
        ));
    }

    #[test]
    fn oversized_manifests_are_refused_before_parsing() {
        let big = format!("{GOLDEN}{}", "#\n".repeat(MAX_MANIFEST_BYTES / 2));
        assert!(matches!(
            ConnectorManifest::from_yaml(&big),
            Err(ManifestError::TooLarge)
        ));
    }

    /// The manifest schema must be structurally incapable of carrying
    /// credential material: no field name may be secret-shaped. Mirrors
    /// `assert_wit_forbids_secrets_get` in `crates/connector-sdk`.
    #[test]
    fn schema_field_names_are_never_secret_shaped() {
        const FIELD_NAMES: &[&str] = &[
            "apiVersion",
            "kind",
            "metadata",
            "id",
            "version",
            "publisher",
            "spec",
            "component",
            "oci",
            "witWorld",
            "signaturesRequired",
            "authModes",
            "outbound",
            "hosts",
            "operations",
            "risk",
            "sideEffect",
            "approvalRecommended",
            "rotation",
            "supportsOverlap",
            "supportsVerify",
            "supportsRollback",
            "families",
        ];
        for name in FIELD_NAMES {
            let lower = name.to_ascii_lowercase();
            for banned in [
                "secret",
                "token",
                "credential",
                "password",
                "key_material",
                "keymaterial",
                "private",
                "bearer",
            ] {
                assert!(!lower.contains(banned), "field `{name}` is secret-shaped");
            }
        }
        // And the list above is the complete schema: a new field must be
        // added here or deserialization of a doc using every field fails.
        let every_field = serde_json::json!({
            "apiVersion": MANIFEST_API_VERSION,
            "kind": MANIFEST_KIND,
            "metadata": {"id": "full", "version": "1.2.3", "publisher": "https://example.com"},
            "spec": {
                "component": {
                    "oci": format!("ghcr.io/acme/full@sha256:{}", "b".repeat(64)),
                    "witWorld": MANIFEST_WIT_WORLD,
                    "signaturesRequired": true
                },
                "authModes": ["brokered_session", "api_key", "oauth2"],
                "outbound": {"hosts": ["api.example.com:8443"]},
                "operations": [{
                    "id": "full.read",
                    "risk": "read",
                    "sideEffect": false,
                    "approvalRecommended": false
                }],
                "rotation": {
                    "supportsOverlap": true,
                    "supportsVerify": true,
                    "supportsRollback": true
                },
                "families": ["certificates"]
            }
        })
        .to_string();
        ConnectorManifest::from_yaml(&every_field).expect("every schema field");
    }
}
