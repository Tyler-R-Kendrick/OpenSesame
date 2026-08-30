//! Prefer `ConnectionRef` + Intent. `SecretRef` is internal under the connection broker.
//!
//! Host capabilities: authorized HTTP / sign / opaque token handles.
//! There is no secrets.get path for guests.

pub mod manifest;
pub mod providers;
#[cfg(feature = "wasm-connectors")]
pub mod wasm;

use opensesame_domain::{EgressBinding, InvokeLevel, LegacyProjection, PlaceholderPlacement};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
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
    #[error("placeholder is not the one this projection issued")]
    PlaceholderMismatch,
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

/// # Errors
///
/// Returns an error when a required signature is absent or the component
/// digest is not trusted.
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

/// # Errors
///
/// Returns an error when the URL is invalid, non-HTTPS, private, or outside
/// the configured egress policy.
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
#[must_use]
pub fn is_blocked_host(host: &str) -> bool {
    let h = host.trim().to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    // A trailing dot is the DNS root: `localhost.` and `127.0.0.1.` both resolve.
    let h = h.strip_suffix('.').unwrap_or(h);
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
    // A zone id is not part of the address: `fe80::1%eth0` is still link-local.
    let h = h.split('%').next().unwrap_or(h);
    if let Ok(ip) = h.parse::<IpAddr>() {
        return Some(ip);
    }
    parse_inet_aton(h).map(IpAddr::V4)
}

/// `inet_aton` spellings: one to four parts, each decimal, octal (leading zero) or
/// hex (`0x`), where the final part absorbs the remaining bytes. `getaddrinfo`
/// accepts all of them, so `127.1`, `0177.0.0.1` and `0x7f.1` are 127.0.0.1.
fn parse_inet_aton(h: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in &parts {
        values.push(parse_inet_part(part)?);
    }
    let last_index = values.len() - 1;
    let mut raw: u64 = 0;
    for value in &values[..last_index] {
        if *value > 0xff {
            return None;
        }
        raw = (raw << 8) | value;
    }
    // With n parts the last one covers the remaining 4 - (n - 1) bytes.
    let trailing_bits = 8 * (4 - u32::try_from(last_index).ok()?);
    let last = values[last_index];
    if last >= (1u64 << trailing_bits) {
        return None;
    }
    let raw = (raw << trailing_bits) | last;
    u32::try_from(raw).ok().map(Ipv4Addr::from)
}

fn parse_inet_part(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    if let Some(hex) = part.strip_prefix("0x") {
        if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        return u64::from_str_radix(hex, 16).ok();
    }
    if part.len() > 1 && part.starts_with('0') {
        if !part[1..].chars().all(|c| c.is_digit(8)) {
            return None;
        }
        return u64::from_str_radix(&part[1..], 8).ok();
    }
    if !part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    part.parse::<u64>().ok()
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
    let seg = ip.segments();
    // The v6 rules come first. `Ipv6Addr::to_ipv4` reads ::1 as 0.0.0.1, so
    // judging only the v4 view would wave IPv6 loopback through.
    if ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7 unique local
        || (seg[0] & 0xfe00) == 0xfc00
        // fe80::/10 link local
        || (seg[0] & 0xffc0) == 0xfe80
        // 2001:db8::/32 documentation
        || (seg[0] == 0x2001 && seg[1] == 0x0db8)
    {
        return true;
    }
    // IPv4-mapped / IPv4-compatible carry a v4 address; judge that too.
    if let Some(v4) = ip.to_ipv4() {
        if is_blocked_v4(v4) {
            return true;
        }
    }
    // 64:ff9b::/96 NAT64 and 2002::/16 6to4 embed a v4 destination.
    if let Some(embedded) = embedded_v4(seg) {
        return is_blocked_v4(embedded);
    }
    false
}

/// The v4 address carried by a NAT64 or 6to4 address, if any.
fn embedded_v4(seg: [u16; 8]) -> Option<Ipv4Addr> {
    let from_pair = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        return Some(from_pair(seg[6], seg[7]));
    }
    if seg[0] == 0x2002 {
        return Some(from_pair(seg[1], seg[2]));
    }
    None
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
    /// Opaque connection reference the invocation is bound to. Handed to the
    /// host egress layer for credential resolution; never credential bytes.
    #[serde(default)]
    pub connection_ref: String,
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
    fn component_digest(&self) -> &str;
    fn operations(&self) -> &[&str];
    /// # Errors
    ///
    /// Returns an error when the request fails connector validation or execution.
    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError>;
}

/// Deterministic mock connector — no external network; never returns secret bytes.
pub struct MockConnector;

const MOCK_CONNECTOR_ID: &str = "mock";
const MOCK_CONNECTOR_VERSION: &str = "1.0.0";
const MOCK_CONNECTOR_DIGEST: &str = "sha256:mock-connector";

impl Connector for MockConnector {
    fn id(&self) -> &str {
        MOCK_CONNECTOR_ID
    }
    fn version(&self) -> &str {
        MOCK_CONNECTOR_VERSION
    }
    fn component_digest(&self) -> &str {
        MOCK_CONNECTOR_DIGEST
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

#[must_use]
/// # Panics
///
/// Panics only if `serde_json::Value` cannot be canonically serialized.
pub fn opensesame_param_digest(parameters: &Value) -> String {
    opensesame_domain::Intent::parameters_hash(parameters).expect("canonical parameters")
}

/// Host-mediated authorized HTTP — injects credentials; enforces egress; no secret to guest.
///
/// # Errors
///
/// Returns an error when the invoke level or destination policy denies the request.
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

/// # Errors
///
/// Returns an error when the redirect violates the egress policy.
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

/// # Errors
///
/// Returns an error when the destination, placeholder identity, or placement
/// violates the projection policy.
pub fn substitute_placeholder(
    egress: &EgressBinding,
    placement: &PlaceholderPlacement,
    projection: &LegacyProjection,
    req: &SubstitutePlaceholderRequest<'_>,
) -> Result<Value, HostError> {
    // The placeholder is the whole key to the substitution: whatever text is named
    // here gets the real credential written over it. Accept only a placeholder this
    // projection could have issued, so a caller cannot name a string of its own
    // choosing — or another connection's — and have a secret filled in behind it.
    if !projection.accepts_placeholder(req.placeholder) {
        return Err(HostError::PlaceholderMismatch);
    }
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

/// What the host holds for one connection: the projection it issued and the
/// credential it will write behind that projection's placeholder.
///
/// Both belong to the host. A request may name the connection — that is what a
/// reference is for — but it may not name the placeholder to fill or the material
/// to fill it with, which is the whole point of L2.
#[derive(Clone, Debug)]
pub struct HostConnection {
    pub projection: LegacyProjection,
    pub material: String,
}

pub struct HostRuntime {
    pub policy: HostPolicy,
    connectors: HashMap<String, Arc<dyn Connector>>,
    connection_connectors: HashMap<String, String>,
    /// Provider id → connection-policy id (the `connection_connectors` key)
    /// that executes that provider's typed operations. Unbound providers
    /// fall back to the mock policy id, preserving pre-registry behavior.
    provider_connectors: HashMap<String, String>,
    /// `connection_ref` URI → what this host resolved for it.
    pub connections: std::collections::HashMap<String, HostConnection>,
}

impl Default for HostRuntime {
    fn default() -> Self {
        let mut policy = HostPolicy::default();
        policy
            .trusted_digests
            .insert("sha256:mock-connector".into());
        let mut connections = std::collections::HashMap::new();
        connections.insert(
            "conn://demo".to_string(),
            HostConnection {
                projection: LegacyProjection {
                    env_var: "OPENSESAME_PLACEHOLDER".into(),
                    connection_ref_uri: "conn://demo".into(),
                    placeholder_pattern: "ostest_*".into(),
                    issued_placeholder: Some("ostest_placeholder_key0".into()),
                    placement: PlaceholderPlacement::default(),
                    delivery: opensesame_domain::CredentialDeliveryMode::Placeholder,
                },
                material: "ostest_injected_material".into(),
            },
        );
        let mut connectors: HashMap<String, Arc<dyn Connector>> = HashMap::new();
        connectors.insert("mock".into(), Arc::new(MockConnector));
        let connection_connectors = HashMap::from([("demo-conn".into(), "mock".into())]);
        Self {
            policy,
            connectors,
            connection_connectors,
            provider_connectors: HashMap::new(),
            connections,
        }
    }
}

/// The connection-policy id every unbound provider resolves to — the mock
/// connector mounted by `HostRuntime::default()`. Unknown operations on it
/// fail closed with a typed connector error.
pub const FALLBACK_CONNECTION_POLICY_ID: &str = "demo-conn";

impl HostRuntime {
    /// # Errors
    ///
    /// Returns an error when a connector with the same identifier is registered.
    pub fn register_connector(&mut self, connector: Arc<dyn Connector>) -> Result<(), HostError> {
        let id = connector.id().to_owned();
        if self.connectors.contains_key(&id) {
            return Err(HostError::Connector(format!(
                "connector {id} is already registered"
            )));
        }
        self.connectors.insert(id, connector);
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the connector identifier is not registered.
    pub fn bind_connection(
        &mut self,
        connection_id: impl Into<String>,
        connector_id: &str,
    ) -> Result<(), HostError> {
        if !self.connectors.contains_key(connector_id) {
            return Err(HostError::Connector(format!(
                "connector {connector_id} is not registered"
            )));
        }
        self.connection_connectors
            .insert(connection_id.into(), connector_id.into());
        Ok(())
    }

    /// Route a provider's typed operations to a registered connection-policy
    /// id. Refuses ids that nothing is bound to — a provider can never be
    /// pointed at a connector that does not exist (ADR 0065 §5).
    ///
    /// # Errors
    ///
    /// Returns an error when `connection_policy_id` has no bound connector.
    pub fn bind_provider(
        &mut self,
        provider_id: impl Into<String>,
        connection_policy_id: &str,
    ) -> Result<(), HostError> {
        if !self
            .connection_connectors
            .contains_key(connection_policy_id)
        {
            return Err(HostError::Connector(format!(
                "connection policy {connection_policy_id} has no connector"
            )));
        }
        self.provider_connectors
            .insert(provider_id.into(), connection_policy_id.into());
        Ok(())
    }

    /// The connection-policy id that executes `provider_id`'s typed
    /// operations. Unbound providers keep the historical mock fallback,
    /// byte-for-byte: unknown operations there fail closed.
    #[must_use]
    pub fn connector_for_provider(&self, provider_id: &str) -> &str {
        self.provider_connectors
            .get(provider_id)
            .map_or(FALLBACK_CONNECTION_POLICY_ID, String::as_str)
    }

    #[must_use]
    pub fn component_digest(&self, connection_id: &str) -> Option<&str> {
        self.connector(connection_id)
            .map(Connector::component_digest)
    }

    /// # Errors
    ///
    /// Returns an error when trust, destination, invoke-level, operation, or
    /// connector validation fails.
    pub fn invoke(
        &self,
        connection_id: &str,
        req: &InvokeRequest,
    ) -> Result<InvokeResult, HostError> {
        let connector = self.connector(connection_id).ok_or_else(|| {
            HostError::Connector(format!("connection {connection_id} has no connector"))
        })?;
        if let Some(url) = req.parameters.get("url").and_then(|v| v.as_str()) {
            assert_destination_allowed(&self.policy, url)?;
        }
        assert_component_trusted(&self.policy, connector.component_digest(), true)?;
        let level = req
            .invoke_level
            .map_or(InvokeLevel::TypedOperation, |n| match n {
                1 => InvokeLevel::TypedOperation,
                2 => InvokeLevel::ConstrainedHttp,
                _ => InvokeLevel::Materialize,
            });
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
        if !connector.operations().contains(&req.operation.as_str()) {
            return Err(HostError::Connector(format!(
                "connector {} does not implement {}",
                connector.id(),
                req.operation
            )));
        }
        connector.invoke(req)
    }

    fn connector(&self, connection_id: &str) -> Option<&dyn Connector> {
        let connector_id = self.connection_connectors.get(connection_id)?;
        self.connectors.get(connector_id).map(Arc::as_ref)
    }

    fn invoke_l2_placeholder(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
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

        // Credential material is never a request parameter. A caller that names it
        // is either confused or trying to have the host write a string of its own
        // choosing into an outbound request.
        if req.parameters.get("material").is_some() {
            return Err(HostError::MaterializeDenied);
        }

        let connection_ref = req
            .parameters
            .get("connection_ref")
            .and_then(|v| v.as_str())
            .unwrap_or("conn://demo");
        let conn = self
            .connections
            .get(connection_ref)
            .ok_or_else(|| HostError::Connector("unknown connection".into()))?;
        let proj = conn.projection.clone();
        let placeholder = proj
            .issued_placeholder
            .clone()
            .ok_or(HostError::PlaceholderMismatch)?;
        // A request may repeat the placeholder it was handed — it has to, to place it
        // — but it may not name a different one and have a credential follow.
        if let Some(named) = req.parameters.get("placeholder").and_then(|v| v.as_str()) {
            if named != placeholder {
                return Err(HostError::PlaceholderMismatch);
            }
        }
        let material = conn.material.clone();
        let placeholder = placeholder.as_str();
        let material = material.as_str();
        let header_name = req.parameters.get("header_name").and_then(|v| v.as_str());
        let header_value = req.parameters.get("header_value").and_then(|v| v.as_str());
        let body_field = req.parameters.get("body_field").and_then(|v| v.as_str());
        let body_value = req.parameters.get("body_value").and_then(|v| v.as_str());

        let placement = proj.placement.clone();

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
    ///
    /// # Errors
    ///
    /// Returns an error when an import would expose secret materialization.
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
    ///
    /// # Errors
    ///
    /// Returns an error when the guest import set is unsafe.
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
    fn short_and_zoned_spellings_of_private_addresses_are_blocked() {
        for host in [
            // getaddrinfo fills the missing bytes: all of these are 127.0.0.1.
            "127.1",
            "0177.0.0.1",
            "0x7f.1",
            "127.0.1",
            "10.1",
            "0xa.0.0.1",
            // A trailing dot is the DNS root, not a different name.
            "127.0.0.1.",
            "localhost.",
            // IPv6 loopback: to_ipv4 reads ::1 as 0.0.0.1, which is routable.
            "::1",
            "[::1]",
            // A zone id does not make a link-local address public.
            "fe80::1%eth0",
            // NAT64 and 6to4 wrappers around 127.0.0.1 / 169.254.169.254.
            "64:ff9b::7f00:1",
            "2002:a9fe:a9fe::1",
        ] {
            assert!(is_blocked_host(host), "{host} should be blocked");
        }
    }

    #[test]
    fn short_spellings_of_public_addresses_still_pass() {
        for host in ["8.8.8.8", "1.1.1.1", "0x08080808", "134744072"] {
            assert!(!is_blocked_host(host), "{host} should not be blocked");
        }
        // Not an address at all — names are the egress allowlist's problem.
        for host in ["10th.example.com", "127.example.com", "0x.example.com"] {
            assert!(!is_blocked_host(host), "{host} should not be blocked");
        }
    }

    #[test]
    fn malformed_numeric_hosts_are_not_read_as_addresses() {
        // Out-of-range parts are not an address, so they fall to the allowlist
        // rather than silently wrapping into one.
        for host in ["300.1", "127.0.0.256", "1.2.3.4.5", "0x1g.1", "09.1"] {
            assert_eq!(parse_host_ip(host), None, "{host} parsed as an address");
        }
        assert_eq!(
            parse_host_ip("127.1"),
            Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)))
        );
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
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "pull_request.create".into(),
                    resource: "repo:acme/catalog".into(),
                    audience: "https://api.github.com".into(),
                    parameters: params,
                    parameters_digest: digest,
                    authorized_operation: "pull_request.create".into(),
                    invoke_level: Some(1),
                    connection_ref: String::new(),
                },
            )
            .unwrap();
        assert!(res.ok);
        assert_eq!(res.safe_summary["pr_number"], 42);
    }

    #[test]
    fn operation_mismatch_denied() {
        let rt = HostRuntime::default();
        let params = json!({});
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "pull_request.create".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: params.clone(),
                    parameters_digest: opensesame_param_digest(&params),
                    authorized_operation: "repository.read".into(),
                    invoke_level: None,
                    connection_ref: String::new(),
                },
            )
            .unwrap_err();
        assert_eq!(err, HostError::OperationMismatch);
    }

    #[test]
    fn param_digest_mismatch_denied() {
        let rt = HostRuntime::default();
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "repository.read".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: json!({"a": 1}),
                    parameters_digest: "sha256:nope".into(),
                    authorized_operation: "repository.read".into(),
                    invoke_level: None,
                    connection_ref: String::new(),
                },
            )
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
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "repository.read".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: params.clone(),
                    parameters_digest: opensesame_param_digest(&params),
                    authorized_operation: "repository.read".into(),
                    invoke_level: None,
                    connection_ref: String::new(),
                },
            )
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
                .invoke(
                    "demo-conn",
                    &InvokeRequest {
                        operation: op.into(),
                        resource: "r".into(),
                        audience: "a".into(),
                        parameters: params.clone(),
                        parameters_digest: opensesame_param_digest(&params),
                        authorized_operation: op.into(),
                        invoke_level: None,
                        connection_ref: String::new(),
                    }
                )
                .is_err());
        }
    }

    #[test]
    fn materialize_denied_even_on_mock() {
        let rt = HostRuntime::default();
        let params = json!({});
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "credential.resolve".into(),
                    resource: "r".into(),
                    audience: "a".into(),
                    parameters: params.clone(),
                    parameters_digest: opensesame_param_digest(&params),
                    authorized_operation: "credential.resolve".into(),
                    invoke_level: Some(3),
                    connection_ref: String::new(),
                },
            )
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
    #[expect(
        clippy::too_many_lines,
        reason = "one cohesive adversarial matrix documents placeholder binding invariants"
    )]
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
            issued_placeholder: None,
            placement: PlaceholderPlacement::default(),
            delivery: CredentialDeliveryMode::Placeholder,
        };
        let ph = proj.shaped_placeholder("0123456789abcdef");
        let ph = ph.as_str();
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

        // A placeholder the projection never issued is refused before anything else.
        let foreign = substitute_placeholder(
            &egress,
            &proj.placement,
            &proj,
            &SubstitutePlaceholderRequest {
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                header_name: Some("Authorization"),
                header_value: Some("Bearer oslive_someone_elses"),
                body_field_path: None,
                body_field_value: None,
                placeholder: "oslive_someone_elses",
                real_secret: "ostest_injected_material",
            },
        );
        assert!(
            matches!(foreign, Err(HostError::PlaceholderMismatch)),
            "{foreign:?}"
        );

        // Repeating an accepted placeholder in the allowed header still trips the
        // occurrence bound — substitution replaces every appearance.
        let doubled = substitute_placeholder(
            &egress,
            &proj.placement,
            &proj,
            &SubstitutePlaceholderRequest {
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                header_name: Some("Authorization"),
                header_value: Some(&format!("Bearer {ph} {ph}")),
                body_field_path: None,
                body_field_value: None,
                placeholder: ph,
                real_secret: "ostest_injected_material",
            },
        );
        assert!(
            matches!(doubled, Err(HostError::PlacementDenied(_))),
            "{doubled:?}"
        );

        // Once the issued placeholder is recorded, a neighbour's placeholder of the
        // same shape is refused too.
        let bound = LegacyProjection {
            issued_placeholder: Some(ph.to_string()),
            ..proj.clone()
        };
        let neighbour = bound.shaped_placeholder("fedcba9876543210");
        let refused = substitute_placeholder(
            &egress,
            &bound.placement,
            &bound,
            &SubstitutePlaceholderRequest {
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                header_name: Some("Authorization"),
                header_value: Some(&format!("Bearer {neighbour}")),
                body_field_path: None,
                body_field_value: None,
                placeholder: &neighbour,
                real_secret: "ostest_injected_material",
            },
        );
        assert!(
            matches!(refused, Err(HostError::PlaceholderMismatch)),
            "{refused:?}"
        );
    }

    #[test]
    fn registry_l2_refuses_material_and_a_foreign_placeholder() {
        let rt = HostRuntime::default();
        // The host resolves the credential from the connection. A caller naming its
        // own material is refused rather than obliged.
        let with_material = json!({
            "url": "https://api.github.com/repos/acme/x",
            "method": "GET",
            "header_name": "Authorization",
            "header_value": "Bearer ostest_placeholder_key0",
            "material": "attacker-chosen",
        });
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "http.authorized".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: with_material.clone(),
                    parameters_digest: opensesame_param_digest(&with_material),
                    authorized_operation: "http.authorized".into(),
                    invoke_level: Some(2),
                    connection_ref: String::new(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, HostError::MaterializeDenied), "{err:?}");

        // Naming somebody else's placeholder does not get it filled either.
        let foreign = json!({
            "url": "https://api.github.com/repos/acme/x",
            "method": "GET",
            "header_name": "Authorization",
            "header_value": "Bearer ostest_someone_elses0",
            "placeholder": "ostest_someone_elses0",
        });
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "http.authorized".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: foreign.clone(),
                    parameters_digest: opensesame_param_digest(&foreign),
                    authorized_operation: "http.authorized".into(),
                    invoke_level: Some(2),
                    connection_ref: String::new(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, HostError::PlaceholderMismatch), "{err:?}");

        // A connection this host holds nothing for cannot be exercised at all.
        let unknown = json!({
            "url": "https://api.github.com/repos/acme/x",
            "method": "GET",
            "header_name": "Authorization",
            "header_value": "Bearer ostest_placeholder_key0",
            "connection_ref": "conn://not-mine",
        });
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "http.authorized".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: unknown.clone(),
                    parameters_digest: opensesame_param_digest(&unknown),
                    authorized_operation: "http.authorized".into(),
                    invoke_level: Some(2),
                    connection_ref: String::new(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, HostError::Connector(_)), "{err:?}");
    }

    #[test]
    fn registry_l2_wrong_placement_denied() {
        let rt = HostRuntime::default();
        let ph = "ostest_placeholder_key0";
        // Default placement is Authorization header only — body occurrence is denied.
        let params = json!({
            "url": "https://api.github.com/repos/acme/x",
            "method": "POST",
            "placeholder": ph,
            "body_field": "message",
            "body_value": format!("exfil {ph}"),
        });
        let err = rt
            .invoke(
                "demo-conn",
                &InvokeRequest {
                    operation: "http.authorized".into(),
                    resource: "r".into(),
                    audience: "https://api.github.com".into(),
                    parameters: params.clone(),
                    parameters_digest: opensesame_param_digest(&params),
                    authorized_operation: "http.authorized".into(),
                    invoke_level: Some(2),
                    connection_ref: String::new(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, HostError::PlacementDenied(_)), "{err:?}");
    }

    #[test]
    fn provider_binding_routes_and_falls_back() {
        let mut host = HostRuntime::default();
        // Unbound: historical fallback, byte-for-byte.
        assert_eq!(host.connector_for_provider("github"), "demo-conn");
        // Binding to a policy id nothing serves is refused.
        assert!(host.bind_provider("github", "nope").is_err());
        // Binding to the mounted policy id routes the provider there.
        host.bind_provider("github", "demo-conn").expect("bind");
        assert_eq!(host.connector_for_provider("github"), "demo-conn");
    }
}
