//! Prefer ConnectionRef + Intent. SecretRef is internal under the connection broker.
//!
//! Host capabilities: authorized HTTP / sign / opaque token handles.
//! There is no secrets.get path for guests.

use opensesame_domain::{EgressBinding, InvokeLevel, LegacyProjection, PlaceholderPlacement};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use thiserror::Error;
use url::Url;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HostError {
    #[error("destination not allowlisted: {0}")]
    DestinationDenied(String),
    #[error("private or link-local address blocked")]
    PrivateAddress,
    #[error("digest mismatch")]
    DigestMismatch,
    #[error("unsigned or untrusted component")]
    UntrustedComponent,
    #[error("parameter digest mismatch")]
    ParameterDigestMismatch,
    #[error("operation mismatch")]
    OperationMismatch,
    #[error("invoke level denied")]
    InvokeLevelDenied,
    #[error("secret materialization denied")]
    MaterializeDenied,
    #[error("cross-authority redirect denied")]
    RedirectDenied,
    #[error("placeholder placement denied: {0}")]
    PlacementDenied(String),
    #[error("connector error: {0}")]
    Connector(String),
}

#[derive(Clone, Debug)]
pub struct HostPolicy {
    pub allowed_hosts: HashSet<String>,
    pub require_signature: bool,
    pub trusted_digests: HashSet<String>,
    pub max_invoke_level: InvokeLevel,
    pub egress: EgressBinding,
}

impl Default for HostPolicy {
    fn default() -> Self {
        let mut allowed_hosts = HashSet::new();
        allowed_hosts.insert("api.github.com:443".into());
        allowed_hosts.insert("github.com:443".into());
        Self {
            allowed_hosts,
            require_signature: true,
            trusted_digests: HashSet::new(),
            max_invoke_level: InvokeLevel::ConstrainedHttp,
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec![
                    "api.github.com".into(),
                    "api.github.com:443".into(),
                    "github.com".into(),
                    "github.com:443".into(),
                ],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
        }
    }
}

pub fn assert_component_trusted(
    policy: &HostPolicy,
    digest: &str,
    signed: bool,
) -> Result<(), HostError> {
    if policy.require_signature && !signed {
        return Err(HostError::UntrustedComponent);
    }
    if !policy.trusted_digests.is_empty() && !policy.trusted_digests.contains(digest) {
        return Err(HostError::DigestMismatch);
    }
    Ok(())
}

pub fn assert_destination_allowed(policy: &HostPolicy, raw_url: &str) -> Result<(), HostError> {
    let url = Url::parse(raw_url).map_err(|_| HostError::DestinationDenied(raw_url.into()))?;
    if url.scheme() != "https" {
        return Err(HostError::DestinationDenied(raw_url.into()));
    }
    let host = url.host_str().unwrap_or_default();
    if is_blocked_host(host) {
        return Err(HostError::PrivateAddress);
    }
    policy
        .egress
        .allows_url(raw_url)
        .map_err(|e| HostError::DestinationDenied(e.to_string()))?;
    Ok(())
}

/// True when the host names a loopback, private, link-local, or otherwise
/// non-routable address, or a known metadata endpoint.
///
/// Literals are parsed rather than prefix-matched: `2130706433` and
/// `::ffff:127.0.0.1` are both 127.0.0.1, and `fcbank.example.com` is not a
/// unique-local address just because it starts with `fc`.
pub fn is_blocked_host(host: &str) -> bool {
    let h = host.trim().to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h.is_empty() {
        return true;
    }
    if h == "localhost" || h.ends_with(".localhost") || h == "metadata.google.internal" {
        return true;
    }
    match parse_host_ip(h) {
        Some(IpAddr::V4(v4)) => is_blocked_v4(v4),
        Some(IpAddr::V6(v6)) => is_blocked_v6(v6),
        // A name we cannot resolve here: the egress allowlist is the fence.
        None => false,
    }
}

/// Accept the forms a URL host can take, including the integer and hex spellings
/// `Ipv4Addr::from_str` rejects but resolvers accept.
fn parse_host_ip(h: &str) -> Option<IpAddr> {
    if let Ok(ip) = h.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Some(hex) = h.strip_prefix("0x") {
        if let Ok(raw) = u32::from_str_radix(hex, 16) {
            return Some(IpAddr::V4(Ipv4Addr::from(raw)));
        }
        return None;
    }
    if h.len() > 1 && h.starts_with('0') && h.chars().skip(1).all(|c| c.is_digit(8)) {
        if let Ok(raw) = u32::from_str_radix(&h[1..], 8) {
            return Some(IpAddr::V4(Ipv4Addr::from(raw)));
        }
        return None;
    }
    if h.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(raw) = h.parse::<u32>() {
            return Some(IpAddr::V4(Ipv4Addr::from(raw)));
        }
    }
    None
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // 100.64.0.0/10 CGNAT
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        // 192.0.0.0/24 IETF protocol assignments
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 198.18.0.0/15 benchmarking
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        // 240.0.0.0/4 reserved
        || o[0] >= 240
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    // IPv4-mapped / IPv4-compatible carry a v4 address; judge that instead.
    if let Some(v4) = ip.to_ipv4() {
        return is_blocked_v4(v4);
    }
    let seg = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7 unique local
        || (seg[0] & 0xfe00) == 0xfc00
        // fe80::/10 link local
        || (seg[0] & 0xffc0) == 0xfe80
        // 2001:db8::/32 documentation
        || (seg[0] == 0x2001 && seg[1] == 0x0db8)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InvokeRequest {
    pub operation: String,
    pub resource: String,
    pub audience: String,
    pub parameters: Value,
    pub parameters_digest: String,
    pub authorized_operation: String,
    #[serde(default)]
    pub invoke_level: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InvokeResult {
    pub ok: bool,
    pub safe_summary: Value,
    pub external_request_digest: Option<String>,
}

pub trait Connector: Send + Sync {
    fn id(&self) -> &str;
    fn version(&self) -> &str;
    fn operations(&self) -> &[&str];
    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError>;
}

/// Deterministic mock connector — no external network; never returns secret bytes.
pub struct MockConnector;

impl Connector for MockConnector {
    fn id(&self) -> &str {
        "mock"
    }
    fn version(&self) -> &str {
        "1.0.0"
    }
    fn operations(&self) -> &[&str] {
        &[
            "repository.read",
            "pull_request.create",
            "error.transient",
            "error.permanent",
            "error.rate_limit",
            "error.timeout",
            "error.indeterminate",
            "rotate.plan",
            "credential.resolve",
        ]
    }
    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        if req.operation != req.authorized_operation {
            return Err(HostError::OperationMismatch);
        }
        let expected = opensesame_param_digest(&req.parameters);
        if expected != req.parameters_digest {
            return Err(HostError::ParameterDigestMismatch);
        }
        if req.operation == "credential.resolve"
            || req.invoke_level == Some(InvokeLevel::Materialize.as_u8())
        {
            return Err(HostError::MaterializeDenied);
        }
        match req.operation.as_str() {
            "error.transient" => Err(HostError::Connector("transient".into())),
            "error.permanent" => Err(HostError::Connector("permanent".into())),
            "error.rate_limit" => Err(HostError::Connector("rate_limited".into())),
            "error.timeout" => Err(HostError::Connector("timeout".into())),
            "error.indeterminate" => Err(HostError::Connector("indeterminate".into())),
            "repository.read" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"resource": req.resource, "title": "README"}),
                external_request_digest: Some("sha256:mock-read".into()),
            }),
            "pull_request.create" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"pr_number": 42, "resource": req.resource}),
                external_request_digest: Some("sha256:mock-pr".into()),
            }),
            "rotate.plan" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"steps": ["generate", "install", "verify", "revoke"]}),
                external_request_digest: None,
            }),
            other => Err(HostError::Connector(format!("unknown op {other}"))),
        }
    }
}

pub fn opensesame_param_digest(parameters: &Value) -> String {
    opensesame_domain::Intent::parameters_hash(parameters).expect("canonical parameters")
}

/// Host-mediated authorized HTTP — injects credentials; enforces egress; no secret to guest.
pub fn authorized_http_request(
    policy: &HostPolicy,
    level: InvokeLevel,
    method: &str,
    url: &str,
) -> Result<Value, HostError> {
    if level > policy.max_invoke_level {
        return Err(HostError::InvokeLevelDenied);
    }
    if level < InvokeLevel::ConstrainedHttp {
        return Err(HostError::InvokeLevelDenied);
    }
    assert_destination_allowed(policy, url)?;
    Ok(json!({
        "status": 200,
        "method": method,
        "url": url,
        "credential_injected": true,
        "credential_bytes_returned_to_guest": false
    }))
}

pub fn follow_redirect_with_credential(
    policy: &HostPolicy,
    from: &str,
    to: &str,
) -> Result<(), HostError> {
    policy
        .egress
        .allows_redirect(from, to)
        .map_err(|_| HostError::RedirectDenied)
}

/// Substitute a placeholder with a real credential **only** when placement rules allow.
/// Never performs generic body-wide string replace.
pub struct SubstitutePlaceholderRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub header_name: Option<&'a str>,
    pub header_value: Option<&'a str>,
    pub body_field_path: Option<&'a str>,
    pub body_field_value: Option<&'a str>,
    pub placeholder: &'a str,
    pub real_secret: &'a str,
}

pub fn substitute_placeholder(
    egress: &EgressBinding,
    placement: &PlaceholderPlacement,
    projection: &LegacyProjection,
    req: &SubstitutePlaceholderRequest<'_>,
) -> Result<Value, HostError> {
    egress
        .allows_url(req.url)
        .map_err(|e| HostError::DestinationDenied(e.to_string()))?;
    let parsed = Url::parse(req.url).map_err(|e| HostError::DestinationDenied(e.to_string()))?;
    placement
        .assert_allowed(
            &opensesame_domain::PlaceholderRequestView {
                method: req.method,
                header_name: req.header_name,
                header_value: req.header_value,
                path: parsed.path(),
                query: parsed.query(),
                body_field_path: req.body_field_path,
                body_field_value: req.body_field_value,
            },
            req.placeholder,
        )
        .map_err(|e| HostError::PlacementDenied(e.to_string()))?;

    let mut injected_header = None;
    if let (Some(hn), Some(hv)) = (req.header_name, req.header_value) {
        if hv.contains(req.placeholder) {
            // Host injects the real secret on the wire; guest summary stays redacted.
            let _wired = hv.replace(req.placeholder, req.real_secret);
            injected_header = Some((hn.to_string(), hv.replace(req.placeholder, "[REDACTED]")));
        }
    }
    let mut injected_body = None;
    if let (Some(fp), Some(fv)) = (req.body_field_path, req.body_field_value) {
        if fv.contains(req.placeholder) {
            let _wired = fv.replace(req.placeholder, req.real_secret);
            injected_body = Some(json!({ fp: fv.replace(req.placeholder, "[REDACTED]") }));
        }
    }

    Ok(json!({
        "ok": true,
        "connection_ref": projection.connection_ref_uri,
        "env_var": projection.env_var,
        "credential_injected": true,
        "credential_bytes_returned_to_guest": false,
        "header": injected_header,
        "body_field": injected_body,
    }))
}

pub struct HostRuntime {
    pub policy: HostPolicy,
    pub mock: MockConnector,
}

impl Default for HostRuntime {
    fn default() -> Self {
        let mut policy = HostPolicy::default();
        policy
            .trusted_digests
            .insert("sha256:mock-connector".into());
        Self {
            policy,
            mock: MockConnector,
        }
    }
}

impl HostRuntime {
    pub fn invoke_mock(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        if let Some(url) = req.parameters.get("url").and_then(|v| v.as_str()) {
            assert_destination_allowed(&self.policy, url)?;
        }
        assert_component_trusted(&self.policy, "sha256:mock-connector", true)?;
        let level = req
            .invoke_level
            .map(|n| match n {
                1 => InvokeLevel::TypedOperation,
                2 => InvokeLevel::ConstrainedHttp,
                _ => InvokeLevel::Materialize,
            })
            .unwrap_or(InvokeLevel::TypedOperation);
        // Materialize / resolve is denied at the host boundary before mock execution.
        // Prefer MaterializeDenied over InvokeLevelDenied so agents cannot confuse
        // "raise connection max" with "export is allowed".
        if level == InvokeLevel::Materialize || req.operation == "credential.resolve" {
            return Err(HostError::MaterializeDenied);
        }
        if level > self.policy.max_invoke_level {
            return Err(HostError::InvokeLevelDenied);
        }
        // L2 constrained HTTP with placement-bound placeholder substitution.
        if level == InvokeLevel::ConstrainedHttp
            && (req.operation == "http.authorized" || req.parameters.get("placeholder").is_some())
        {
            return self.invoke_l2_placeholder(req);
        }
        self.mock.invoke(req)
    }

    fn invoke_l2_placeholder(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        use opensesame_domain::CredentialDeliveryMode;

        let url = req
            .parameters
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| HostError::Connector("url required for L2".into()))?;
        let method = req
            .parameters
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET");
        let placeholder = req
            .parameters
            .get("placeholder")
            .and_then(|v| v.as_str())
            .unwrap_or("ostest_placeholder_key0");
        let material = req
            .parameters
            .get("material")
            .and_then(|v| v.as_str())
            .unwrap_or("ostest_injected_material");
        let header_name = req.parameters.get("header_name").and_then(|v| v.as_str());
        let header_value = req.parameters.get("header_value").and_then(|v| v.as_str());
        let body_field = req.parameters.get("body_field").and_then(|v| v.as_str());
        let body_value = req.parameters.get("body_value").and_then(|v| v.as_str());

        let placement = PlaceholderPlacement::default();

        let proj = LegacyProjection {
            env_var: "OPENSESAME_PLACEHOLDER".into(),
            connection_ref_uri: req
                .parameters
                .get("connection_ref")
                .and_then(|v| v.as_str())
                .unwrap_or("conn://demo")
                .into(),
            placeholder_pattern: "ostest_*".into(),
            placement: placement.clone(),
            delivery: CredentialDeliveryMode::Placeholder,
        };

        let injected = substitute_placeholder(
            &self.policy.egress,
            &placement,
            &proj,
            &SubstitutePlaceholderRequest {
                method,
                url,
                header_name,
                header_value,
                body_field_path: body_field,
                body_field_value: body_value,
                placeholder,
                real_secret: material,
            },
        )?;
        Ok(InvokeResult {
            ok: true,
            safe_summary: injected,
            external_request_digest: Some("sha256:l2-placeholder".into()),
        })
    }
}

/// Host-side Wasm guest loader boundary.
/// Guests receive opaque connection handles; materialize/secrets.get is never imported.
pub mod wasm_guest {
    use super::HostError;
    use std::path::Path;

    #[derive(Clone, Debug, Default)]
    pub struct WasmGuestPolicy {
        pub allow_materialize: bool,
    }

    /// Validate a prospective guest import set before Wasmtime instantiation.
    pub fn assert_imports_safe(
        import_names: &[&str],
        policy: &WasmGuestPolicy,
    ) -> Result<(), HostError> {
        for name in import_names {
            let n = name.to_lowercase();
            if n.contains("secrets.get")
                || n.contains("secret.get")
                || n.ends_with("get-secret")
                || (n.contains("materialize") && !policy.allow_materialize)
            {
                return Err(HostError::MaterializeDenied);
            }
        }
        Ok(())
    }

    /// Placeholder load path — real Wasmtime component linking lands behind compile feature.
    pub fn prepare_guest(_path: &Path, imports: &[&str]) -> Result<(), HostError> {
        assert_imports_safe(imports, &WasmGuestPolicy::default())?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_secrets_get_import() {
            assert_eq!(
                assert_imports_safe(
                    &["host-http#authorized-request", "secrets.get"],
                    &WasmGuestPolicy::default()
                ),
                Err(HostError::MaterializeDenied)
            );
        }

        #[test]
        fn allows_authorized_http_only() {
            assert!(assert_imports_safe(
                &["host-http#authorized-request", "host-crypto#sign"],
                &WasmGuestPolicy::default()
            )
            .is_ok());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_metadata_and_localhost() {
        let p = HostPolicy::default();
        assert_eq!(
            assert_destination_allowed(&p, "https://169.254.169.254/latest"),
            Err(HostError::PrivateAddress)
        );
        assert_eq!(
            assert_destination_allowed(&p, "https://localhost/admin"),
            Err(HostError::PrivateAddress)
        );
        assert!(assert_destination_allowed(&p, "https://api.github.com/repos/x").is_ok());
    }

    #[test]
    fn integer_and_mapped_spellings_of_loopback_are_blocked() {
        // 2130706433 == 0x7f000001 == 127.0.0.1; resolvers accept all three.
        for host in [
            "2130706433",
            "0x7f000001",
            "017700000001",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "[::ffff:169.254.169.254]",
            "0.0.0.0",
            "172.16.0.5",
            "100.64.1.1",
            "198.18.0.1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(is_blocked_host(host), "{host} should be blocked");
        }
    }

    #[test]
    fn names_that_merely_look_like_private_ranges_are_not_blocked_here() {
        // The old prefix test blocked these outright.
        for host in ["fcbank.example.com", "fdic.example.gov", "10th.example.com"] {
            assert!(!is_blocked_host(host), "{host} should not be blocked");
        }
        assert!(is_blocked_host("app.localhost"));
    }

    #[test]
    fn rejects_unsigned_component() {
        let p = HostPolicy::default();
        assert_eq!(
            assert_component_trusted(&p, "sha256:x", false),
            Err(HostError::UntrustedComponent)
        );
    }

    #[test]
    fn mock_invoke_ok() {
        let rt = HostRuntime::default();
        let params = json!({"title": "hi"});
        let digest = opensesame_param_digest(&params);
        let res = rt
            .invoke_mock(&InvokeRequest {
                operation: "pull_request.create".into(),
                resource: "repo:acme/catalog".into(),
                audience: "https://api.github.com".into(),
                parameters: params,
                parameters_digest: digest,
                authorized_operation: "pull_request.create".into(),
                invoke_level: Some(1),
            })
            .unwrap();
        assert!(res.ok);
        assert_eq!(res.safe_summary["pr_number"], 42);
    }

    #[test]
    fn operation_mismatch_denied() {
        let rt = HostRuntime::default();
        let params = json!({});
        let err = rt
            .invoke_mock(&InvokeRequest {
                operation: "pull_request.create".into(),
                resource: "r".into(),
                audience: "https://api.github.com".into(),
                parameters: params.clone(),
                parameters_digest: opensesame_param_digest(&params),
                authorized_operation: "repository.read".into(),
                invoke_level: None,
            })
            .unwrap_err();
        assert_eq!(err, HostError::OperationMismatch);
    }

    #[test]
    fn param_digest_mismatch_denied() {
        let rt = HostRuntime::default();
        let err = rt
            .invoke_mock(&InvokeRequest {
                operation: "repository.read".into(),
                resource: "r".into(),
                audience: "https://api.github.com".into(),
                parameters: json!({"a": 1}),
                parameters_digest: "sha256:nope".into(),
                authorized_operation: "repository.read".into(),
                invoke_level: None,
            })
            .unwrap_err();
        assert_eq!(err, HostError::ParameterDigestMismatch);
    }

    #[test]
    fn undeclared_github_host_ok_declared_evil_denied() {
        let p = HostPolicy::default();
        assert!(assert_destination_allowed(&p, "https://api.github.com/v").is_ok());
        assert!(matches!(
            assert_destination_allowed(&p, "https://evil.example/x"),
            Err(HostError::DestinationDenied(_))
        ));
    }

    #[test]
    fn http_scheme_denied() {
        let p = HostPolicy::default();
        assert!(matches!(
            assert_destination_allowed(&p, "http://api.github.com/v"),
            Err(HostError::DestinationDenied(_))
        ));
    }

    #[test]
    fn ssrf_via_url_parameter_blocked() {
        let rt = HostRuntime::default();
        let params = json!({"url": "https://169.254.169.254/latest"});
        let err = rt
            .invoke_mock(&InvokeRequest {
                operation: "repository.read".into(),
                resource: "r".into(),
                audience: "https://api.github.com".into(),
                parameters: params.clone(),
                parameters_digest: opensesame_param_digest(&params),
                authorized_operation: "repository.read".into(),
                invoke_level: None,
            })
            .unwrap_err();
        assert_eq!(err, HostError::PrivateAddress);
    }

    #[test]
    fn digest_mismatch_component() {
        let mut p = HostPolicy::default();
        p.trusted_digests.insert("sha256:good".into());
        assert_eq!(
            assert_component_trusted(&p, "sha256:bad", true),
            Err(HostError::DigestMismatch)
        );
    }

    #[test]
    fn mock_error_modes() {
        let rt = HostRuntime::default();
        for op in [
            "error.transient",
            "error.permanent",
            "error.rate_limit",
            "error.timeout",
            "error.indeterminate",
        ] {
            let params = json!({});
            assert!(rt
                .invoke_mock(&InvokeRequest {
                    operation: op.into(),
                    resource: "r".into(),
                    audience: "a".into(),
                    parameters: params.clone(),
                    parameters_digest: opensesame_param_digest(&params),
                    authorized_operation: op.into(),
                    invoke_level: None,
                })
                .is_err());
        }
    }

    #[test]
    fn materialize_denied_even_on_mock() {
        let rt = HostRuntime::default();
        let params = json!({});
        let err = rt
            .invoke_mock(&InvokeRequest {
                operation: "credential.resolve".into(),
                resource: "r".into(),
                audience: "a".into(),
                parameters: params.clone(),
                parameters_digest: opensesame_param_digest(&params),
                authorized_operation: "credential.resolve".into(),
                invoke_level: Some(3),
            })
            .unwrap_err();
        assert_eq!(err, HostError::MaterializeDenied);
    }

    #[test]
    fn authorized_http_injects_without_returning_secret() {
        let p = HostPolicy::default();
        let v = authorized_http_request(
            &p,
            InvokeLevel::ConstrainedHttp,
            "GET",
            "https://api.github.com/repos/acme/x",
        )
        .unwrap();
        assert_eq!(v["credential_bytes_returned_to_guest"], false);
        assert_eq!(v["credential_injected"], true);
    }

    #[test]
    fn redirect_exfil_blocked() {
        let p = HostPolicy::default();
        assert_eq!(
            follow_redirect_with_credential(
                &p,
                "https://api.github.com/repos/x",
                "https://evil.example/steal"
            ),
            Err(HostError::RedirectDenied)
        );
    }

    #[test]
    fn placeholder_header_ok_body_denied() {
        use opensesame_domain::{CredentialDeliveryMode, LegacyProjection, PlaceholderPlacement};
        let egress = EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.stripe.com".into()],
            path_prefixes: vec![],
            allow_redirects_cross_authority: false,
        };
        let proj = LegacyProjection {
            env_var: "STRIPE_SECRET_KEY".into(),
            connection_ref_uri: "conn://demo/stripe".into(),
            placeholder_pattern: "sk_test_*".into(),
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        let ph = "ostest_placeholder_key0";
        let ok = substitute_placeholder(
            &egress,
            &proj.placement,
            &proj,
            &SubstitutePlaceholderRequest {
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                header_name: Some("Authorization"),
                header_value: Some(&format!("Bearer {ph}")),
                body_field_path: None,
                body_field_value: None,
                placeholder: ph,
                real_secret: "ostest_injected_material",
            },
        )
        .unwrap();
        assert_eq!(ok["credential_bytes_returned_to_guest"], false);
        assert_eq!(ok["credential_injected"], true);
        let header_val = ok["header"][1].as_str().unwrap();
        assert!(header_val.contains("[REDACTED]"));
        assert!(!header_val.contains("ostest_injected_material"));

        let deny = substitute_placeholder(
            &egress,
            &proj.placement,
            &proj,
            &SubstitutePlaceholderRequest {
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                header_name: None,
                header_value: None,
                body_field_path: Some("message"),
                body_field_value: Some(&format!("exfil {ph}")),
                placeholder: ph,
                real_secret: "ostest_injected_material",
            },
        );
        assert!(matches!(deny, Err(HostError::PlacementDenied(_))));
    }

    #[test]
    fn invoke_mock_l2_wrong_placement_denied() {
        let rt = HostRuntime::default();
        let ph = "ostest_placeholder_key0";
        // Default placement is Authorization header only — body occurrence is denied.
        let params = json!({
            "url": "https://api.github.com/repos/acme/x",
            "method": "POST",
            "placeholder": ph,
            "material": "ostest_injected_material",
            "body_field": "message",
            "body_value": format!("exfil {ph}"),
        });
        let err = rt
            .invoke_mock(&InvokeRequest {
                operation: "http.authorized".into(),
                resource: "r".into(),
                audience: "https://api.github.com".into(),
                parameters: params.clone(),
                parameters_digest: opensesame_param_digest(&params),
                authorized_operation: "http.authorized".into(),
                invoke_level: Some(2),
            })
            .unwrap_err();
        assert!(matches!(err, HostError::PlacementDenied(_)), "{err:?}");
    }
}
