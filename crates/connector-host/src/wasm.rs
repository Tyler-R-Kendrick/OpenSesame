//! Wasm component runtime for community connectors — ADR 0061 §3.
//!
//! Shopify-Functions posture, enforced by construction:
//! - the linker binds exactly `types`, `host-http`, `host-crypto`, and
//!   `host-oauth` from `wit/connector/world.wit` — no WASI, no filesystem,
//!   no clock, no randomness, no ambient anything; a component importing
//!   more fails instantiation;
//! - every invocation runs in a **fresh `Store`** (empty linear memory, no
//!   cross-invocation state), under a fuel cap, an epoch deadline, and a
//!   memory limit the manifest cannot raise;
//! - the component's sha256 must equal the manifest digest AND be pinned in
//!   `HostPolicy::trusted_digests` — operator consent binds to content, not
//!   to a name (the anti-rug-pull rule); verified at load and re-verified
//!   before every instantiation;
//! - all egress goes through [`HostEgress`] after re-checking the
//!   *intersection* of `HostPolicy` egress and the manifest's
//!   `outbound.hosts`; credentials are injected on the host side of that
//!   trait and never enter guest linear memory.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasmtime::component::{Component, Linker, Resource};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};

use crate::manifest::ConnectorManifest;
use crate::wasm_guest::{assert_imports_safe, WasmGuestPolicy};
use crate::{
    assert_destination_allowed, opensesame_param_digest, Connector, HostError, HostPolicy,
    InvokeRequest, InvokeResult,
};

mod bindings {
    wasmtime::component::bindgen!({
        world: "connector",
        path: "../../wit/connector",
    });
}

use bindings::opensesame::connector::host_http;
use bindings::opensesame::connector::host_oauth;
use bindings::opensesame::connector::types;

/// One outbound HTTP request as it crosses the host boundary. The connection
/// is identified by ref; the host injects the credential after this value is
/// formed — a guest never sees or supplies credential bytes.
#[derive(Clone, Debug)]
pub struct EgressRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct EgressResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The only way out of a guest. Implementations delegate to the connection
/// broker's authorized egress (`ConnectionBroker::authorized_json`/`_bytes`)
/// so the single credential-injection funnel stays single.
pub trait HostEgress: Send + Sync {
    /// L2 constrained HTTP: destination already fenced by the runtime; the
    /// implementation injects the connection's credential host-side.
    ///
    /// # Errors
    ///
    /// Returns a guest-visible error string; it must never carry credential
    /// material or raw upstream bodies beyond policy.
    fn authorized_request(
        &self,
        connection_ref: &str,
        req: EgressRequest,
    ) -> Result<EgressResponse, String>;

    /// Purpose-bound signing; the key never leaves the host.
    ///
    /// # Errors
    ///
    /// Returns a guest-visible error string.
    fn sign(&self, purpose: &str, digest: &[u8]) -> Result<Vec<u8>, String>;

    /// Acquire an access token, returning an opaque handle id — never bytes.
    ///
    /// # Errors
    ///
    /// Returns a guest-visible error string.
    fn oauth_acquire(
        &self,
        connection_ref: &str,
        resource: Option<&str>,
        audience: Option<&str>,
        scopes: &[String],
    ) -> Result<u32, String>;

    /// Authenticated request using a previously acquired token handle.
    ///
    /// # Errors
    ///
    /// Returns a guest-visible error string.
    fn authenticated_request(
        &self,
        connection_ref: &str,
        token_handle: u32,
        req: EgressRequest,
    ) -> Result<EgressResponse, String>;
}

/// Platform-set execution limits. The manifest has no field that can raise
/// them (ADR 0061 §3 — the hook author never chooses their budget).
#[derive(Clone, Copy, Debug)]
pub struct GuestLimits {
    /// CPU meter: instructions burn fuel; exhaustion traps the invocation.
    pub fuel: u64,
    /// Wall-clock deadline enforced via epoch interruption.
    pub deadline: Duration,
    /// Linear-memory cap per invocation.
    pub max_memory_bytes: usize,
    /// Cap on bytes a guest may return from `invoke`.
    pub max_result_bytes: usize,
    /// Cap on response-body bytes handed back through `host-http`.
    pub max_response_bytes: usize,
}

impl Default for GuestLimits {
    fn default() -> Self {
        Self {
            fuel: 50_000_000,
            deadline: Duration::from_secs(5),
            max_memory_bytes: 64 * 1024 * 1024,
            max_result_bytes: 1024 * 1024,
            max_response_bytes: 4 * 1024 * 1024,
        }
    }
}

const EPOCH_TICK: Duration = Duration::from_millis(50);

struct EpochTicker {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl EpochTicker {
    fn spawn(engine: &Engine) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let weak = engine.weak();
        let handle = std::thread::Builder::new()
            .name("connector-epoch".into())
            .spawn(move || tick_epochs(&flag, &weak))
            .ok();
        Self { stop, handle }
    }
}

fn tick_epochs(stop: &AtomicBool, engine: &wasmtime::EngineWeak) {
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(EPOCH_TICK);
        let Some(engine) = engine.upgrade() else {
            return;
        };
        engine.increment_epoch();
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Per-invocation host state. Created fresh for every invoke and dropped
/// with the store — nothing survives an invocation.
struct GuestState {
    limits: StoreLimits,
    policy: HostPolicy,
    outbound_hosts: HashSet<String>,
    connection_ref: String,
    egress: Arc<dyn HostEgress>,
    max_response_bytes: usize,
}

impl GuestState {
    /// The runtime's egress fence: HTTPS + SSRF checks + `HostPolicy`
    /// egress + manifest outbound intersection. Refusals reach the guest as
    /// plain strings — no oracle beyond "denied".
    fn assert_guest_destination(&self, raw_url: &str) -> Result<(), String> {
        assert_destination_allowed(&self.policy, raw_url)
            .map_err(|_| "destination denied".to_owned())?;
        let url = url::Url::parse(raw_url).map_err(|_| "destination denied".to_owned())?;
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let host_port = match url.port() {
            Some(p) => format!("{host}:{p}"),
            None => host.clone(),
        };
        if self.outbound_hosts.contains(&host) || self.outbound_hosts.contains(&host_port) {
            Ok(())
        } else {
            Err("destination denied".to_owned())
        }
    }

    fn cap_response(&self, mut resp: EgressResponse) -> EgressResponse {
        resp.body.truncate(self.max_response_bytes);
        resp
    }
}

impl types::Host for GuestState {}

impl types::HostConnectionHandle for GuestState {
    fn drop(&mut self, rep: Resource<types::ConnectionHandle>) -> wasmtime::Result<()> {
        let _ = rep;
        Ok(())
    }
}

impl types::HostCredentialHandle for GuestState {
    fn drop(&mut self, rep: Resource<types::CredentialHandle>) -> wasmtime::Result<()> {
        let _ = rep;
        Ok(())
    }
}

impl types::HostKeyHandle for GuestState {
    fn drop(&mut self, rep: Resource<types::KeyHandle>) -> wasmtime::Result<()> {
        let _ = rep;
        Ok(())
    }
}

impl types::HostAccessTokenHandle for GuestState {
    fn drop(&mut self, rep: Resource<types::AccessTokenHandle>) -> wasmtime::Result<()> {
        let _ = rep;
        Ok(())
    }
}

impl host_http::Host for GuestState {
    fn authorized_request(
        &mut self,
        _connection: Resource<types::ConnectionHandle>,
        req: host_http::Request,
    ) -> Result<host_http::Response, String> {
        self.assert_guest_destination(&req.url)?;
        let resp = self.egress.authorized_request(
            &self.connection_ref,
            EgressRequest {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: req.body,
            },
        )?;
        let resp = self.cap_response(resp);
        Ok(host_http::Response {
            status: resp.status,
            headers: resp.headers,
            body: resp.body,
        })
    }
}

impl bindings::opensesame::connector::host_crypto::Host for GuestState {
    fn sign(
        &mut self,
        _key: Resource<types::KeyHandle>,
        purpose: String,
        digest: Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        if purpose.trim().is_empty() {
            return Err("sign requires a purpose".to_owned());
        }
        self.egress.sign(&purpose, &digest)
    }
}

impl host_oauth::Host for GuestState {
    fn acquire(
        &mut self,
        _connection: Resource<types::ConnectionHandle>,
        request: host_oauth::TokenRequest,
    ) -> Result<Resource<types::AccessTokenHandle>, String> {
        let handle = self.egress.oauth_acquire(
            &self.connection_ref,
            request.resource.as_deref(),
            request.audience.as_deref(),
            &request.scopes,
        )?;
        Ok(Resource::new_own(handle))
    }

    fn authenticated_request(
        &mut self,
        _connection: Resource<types::ConnectionHandle>,
        token: Resource<types::AccessTokenHandle>,
        request: host_http::Request,
    ) -> Result<host_http::Response, String> {
        self.assert_guest_destination(&request.url)?;
        let resp = self.egress.authenticated_request(
            &self.connection_ref,
            token.rep(),
            EgressRequest {
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: request.body,
            },
        )?;
        let resp = self.cap_response(resp);
        Ok(host_http::Response {
            status: resp.status,
            headers: resp.headers,
            body: resp.body,
        })
    }
}

/// A community connector loaded from a manifest + component bytes.
pub struct WasmConnector {
    engine: Engine,
    component: Component,
    linker: Linker<GuestState>,
    manifest: ConnectorManifest,
    digest: String,
    limits: GuestLimits,
    policy: HostPolicy,
    egress: Arc<dyn HostEgress>,
    info: types::ConnectorInfo,
    operations: Vec<String>,
    /// Operation ids leaked once per load so `Connector::operations` can
    /// return `&[&str]`. Bounded: one small allocation per loaded connector.
    operations_static: Vec<&'static str>,
    _ticker: EpochTicker,
}

impl WasmConnector {
    /// Load, digest-pin, and validate a component against its manifest.
    ///
    /// Fail-closed: any mismatch — digest not pinned in policy, digest not
    /// matching the bytes, unexpected import, missing export, `describe`
    /// disagreeing with the manifest — refuses the load.
    ///
    /// # Errors
    ///
    /// Returns [`HostError`] on any validation or instantiation failure.
    pub fn load(
        manifest: ConnectorManifest,
        component_bytes: &[u8],
        policy: &HostPolicy,
        egress: Arc<dyn HostEgress>,
        limits: GuestLimits,
    ) -> Result<Self, HostError> {
        let digest = format!("sha256:{:x}", Sha256::digest(component_bytes));
        if digest != manifest.component_digest() {
            return Err(HostError::DigestMismatch);
        }
        // Consent is a digest pinned by the operator. An empty pin set is a
        // refusal, not an allow-all.
        if !policy.trusted_digests.contains(&digest) {
            return Err(HostError::UntrustedComponent);
        }

        let mut config = Config::new();
        config.consume_fuel(true);
        config.epoch_interruption(true);
        let engine =
            Engine::new(&config).map_err(|e| HostError::Connector(format!("engine: {e}")))?;
        let component = Component::new(&engine, component_bytes)
            .map_err(|e| HostError::Connector(format!("component: {e:#}")))?;

        // Belt and braces on top of the linker allowlist: enumerate the
        // component's actual imports and refuse secret-shaped names.
        let import_names: Vec<String> = component
            .component_type()
            .imports(&engine)
            .map(|(name, _)| name.to_owned())
            .collect();
        let import_refs: Vec<&str> = import_names.iter().map(String::as_str).collect();
        assert_imports_safe(&import_refs, &WasmGuestPolicy::default())?;
        for name in &import_names {
            if !name.starts_with("opensesame:connector/") {
                return Err(HostError::Connector(format!(
                    "component imports outside the connector world: {name}"
                )));
            }
        }

        let mut linker: Linker<GuestState> = Linker::new(&engine);
        bindings::Connector::add_to_linker(&mut linker, |state: &mut GuestState| state)
            .map_err(|e| HostError::Connector(format!("linker: {e}")))?;

        let ticker = EpochTicker::spawn(&engine);
        let mut connector = Self {
            engine,
            component,
            linker,
            manifest,
            digest,
            limits,
            policy: policy.clone(),
            egress,
            info: types::ConnectorInfo {
                id: String::new(),
                version: String::new(),
                operations: vec![],
            },
            operations: vec![],
            operations_static: vec![],
            _ticker: ticker,
        };

        // Run `describe` once at load: proves the exports exist and binds
        // the manifest identity to what the component says about itself.
        let (mut store, instance) = connector.fresh_instance("")?;
        let info = instance
            .call_describe(&mut store)
            .map_err(|e| WasmConnector::map_guest_error(&e))?;
        if info.id != connector.manifest.metadata.id {
            return Err(HostError::Connector(format!(
                "component identifies as `{}` but the manifest says `{}`",
                info.id, connector.manifest.metadata.id
            )));
        }
        connector.operations = connector
            .manifest
            .spec
            .operations
            .iter()
            .map(|op| op.id.clone())
            .collect();
        connector.operations_static = connector
            .operations
            .iter()
            .map(|op| &*Box::leak(op.clone().into_boxed_str()))
            .collect();
        connector.info = info;
        Ok(connector)
    }

    fn fresh_instance(
        &self,
        connection_ref: &str,
    ) -> Result<(Store<GuestState>, bindings::Connector), HostError> {
        let state = GuestState {
            limits: StoreLimitsBuilder::new()
                .memory_size(self.limits.max_memory_bytes)
                .build(),
            policy: self.policy.clone(),
            outbound_hosts: self
                .manifest
                .spec
                .outbound
                .hosts
                .iter()
                .map(|h| h.to_ascii_lowercase())
                .collect(),
            connection_ref: connection_ref.to_owned(),
            egress: Arc::clone(&self.egress),
            max_response_bytes: self.limits.max_response_bytes,
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store
            .set_fuel(self.limits.fuel)
            .map_err(|e| HostError::Connector(format!("fuel: {e}")))?;
        let ticks = self
            .limits
            .deadline
            .as_millis()
            .div_euclid(EPOCH_TICK.as_millis())
            .max(1);
        store.set_epoch_deadline(u64::try_from(ticks).unwrap_or(1));
        let instance = bindings::Connector::instantiate(&mut store, &self.component, &self.linker)
            .map_err(|e| HostError::Connector(format!("instantiate: {e}")))?;
        Ok((store, instance))
    }

    fn map_guest_error(error: &wasmtime::Error) -> HostError {
        if let Some(trap) = error.downcast_ref::<wasmtime::Trap>() {
            return match trap {
                wasmtime::Trap::OutOfFuel => HostError::Connector("fuel exhausted".into()),
                wasmtime::Trap::Interrupt => HostError::Connector("deadline exceeded".into()),
                other => HostError::Connector(format!("trap: {other}")),
            };
        }
        HostError::Connector(format!("guest: {error}"))
    }
}

fn map_invoke_error(error: &types::InvokeError) -> HostError {
    let text = match error {
        types::InvokeError::InvalidInput(m) => format!("invalid-input: {m}"),
        types::InvokeError::Unauthorized(m) => format!("unauthorized: {m}"),
        types::InvokeError::ApprovalRequired(m) => format!("approval-required: {m}"),
        types::InvokeError::RateLimited(after) => match after {
            Some(secs) => format!("rate-limited: retry after {secs}s"),
            None => "rate-limited".to_owned(),
        },
        types::InvokeError::ProviderError((status, m)) => {
            format!("provider-error {status}: {m}")
        }
        types::InvokeError::Transient(m) => format!("transient: {m}"),
        types::InvokeError::Permanent(m) => format!("permanent: {m}"),
    };
    HostError::Connector(text)
}

impl Connector for WasmConnector {
    fn id(&self) -> &str {
        &self.manifest.metadata.id
    }

    fn version(&self) -> &str {
        &self.manifest.metadata.version
    }

    fn component_digest(&self) -> &str {
        &self.digest
    }

    fn operations(&self) -> &[&str] {
        &self.operations_static
    }

    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        // Dispatcher-enforced checks (ADR 0061 §7): the guest cannot forget
        // them because they run before it does.
        let _ = &req.connection_ref;
        if req.operation != req.authorized_operation {
            return Err(HostError::OperationMismatch);
        }
        if opensesame_param_digest(&req.parameters) != req.parameters_digest {
            return Err(HostError::ParameterDigestMismatch);
        }
        if req.invoke_level == Some(opensesame_domain::InvokeLevel::Materialize.as_u8()) {
            return Err(HostError::MaterializeDenied);
        }
        if !self.operations.iter().any(|op| op == &req.operation) {
            return Err(HostError::OperationMismatch);
        }
        // Re-verify the pin on every invocation: a mutated policy or
        // component cannot ride an old approval.
        if !self.policy.trusted_digests.contains(&self.digest) {
            return Err(HostError::UntrustedComponent);
        }

        let (mut store, instance) = self.fresh_instance(&req.connection_ref)?;
        let connection = Resource::<types::ConnectionHandle>::new_own(0);
        let parameters = serde_json::to_vec(&req.parameters)
            .map_err(|e| HostError::Connector(format!("parameters: {e}")))?;
        let intent = types::Intent {
            id: req.parameters_digest.clone(),
            operation: req.operation.clone(),
            resource: req.resource.clone(),
            audience: req.audience.clone(),
            parameters,
            parameters_digest: req.parameters_digest.clone(),
            expires_at_unix_ms: 0,
            idempotency_key: String::new(),
        };
        let outcome = instance
            .call_invoke(&mut store, connection, &intent)
            .map_err(|e| Self::map_guest_error(&e))?;
        let bytes = outcome.map_err(|e| map_invoke_error(&e))?;
        if bytes.len() > self.limits.max_result_bytes {
            return Err(HostError::Connector("result exceeds size cap".into()));
        }
        let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
        // Guest output is data, never trusted structure: parse as JSON when
        // it is JSON, otherwise report only its size and digest.
        let safe_summary = serde_json::from_slice::<Value>(&bytes)
            .unwrap_or_else(|_| json!({ "bytes": bytes.len() }));
        Ok(InvokeResult {
            ok: true,
            safe_summary,
            external_request_digest: Some(digest),
        })
    }
}

impl WasmConnector {
    /// Operation ids from the manifest (the authoritative allowlist).
    #[must_use]
    pub fn manifest_operations(&self) -> &[String] {
        &self.operations
    }

    /// What the component reported at load time via `describe`.
    #[must_use]
    pub fn described_info(&self) -> (&str, &str) {
        (&self.info.id, &self.info.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoEgress;
    impl HostEgress for NoEgress {
        fn authorized_request(
            &self,
            _connection_ref: &str,
            _req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            Err("unreachable in this test".into())
        }
        fn sign(&self, _purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, String> {
            Err("unreachable in this test".into())
        }
        fn oauth_acquire(
            &self,
            _connection_ref: &str,
            _resource: Option<&str>,
            _audience: Option<&str>,
            _scopes: &[String],
        ) -> Result<u32, String> {
            Err("unreachable in this test".into())
        }
        fn authenticated_request(
            &self,
            _connection_ref: &str,
            _token_handle: u32,
            _req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            Err("unreachable in this test".into())
        }
    }

    fn state_with(outbound: &[&str], policy: HostPolicy) -> GuestState {
        GuestState {
            limits: StoreLimitsBuilder::new().build(),
            policy,
            outbound_hosts: outbound.iter().map(|h| (*h).to_owned()).collect(),
            connection_ref: "conn://test".into(),
            egress: Arc::new(NoEgress),
            max_response_bytes: 1024,
        }
    }

    /// Egress is the *intersection* of `HostPolicy` and the manifest: a host
    /// present in only one of the two is refused, and every refusal reads
    /// the same — no oracle distinguishing which fence fired.
    #[test]
    fn guest_destination_requires_both_fences() {
        let policy = HostPolicy::default(); // allows api.github.com
        let both = state_with(&["api.github.com"], policy.clone());
        assert!(both
            .assert_guest_destination("https://api.github.com/repos")
            .is_ok());

        // In policy, not in the manifest.
        let manifest_missing = state_with(&["api.example.com"], policy.clone());
        assert_eq!(
            manifest_missing.assert_guest_destination("https://api.github.com/repos"),
            Err("destination denied".to_owned())
        );

        // In the manifest, not in policy.
        let policy_missing = state_with(&["api.example.com"], policy.clone());
        assert_eq!(
            policy_missing.assert_guest_destination("https://api.example.com/v1"),
            Err("destination denied".to_owned())
        );

        // SSRF fence still applies underneath both.
        let ssrf = state_with(&["169.254.169.254"], policy);
        assert_eq!(
            ssrf.assert_guest_destination("https://169.254.169.254/latest"),
            Err("destination denied".to_owned())
        );
    }

    #[test]
    fn responses_are_capped() {
        let state = state_with(&[], HostPolicy::default());
        let resp = state.cap_response(EgressResponse {
            status: 200,
            headers: vec![],
            body: vec![0u8; 4096],
        });
        assert_eq!(resp.body.len(), 1024);
    }
}
