//! Boot-time loading of community Wasm connectors (ADR 0065 §5) and the
//! gateway's [`HostEgress`] bridge.
//!
//! Operator contract, fail-closed at every step:
//! - `OPENSESAME_CONNECTOR_DIR` names a directory of `<id>/connector.yaml` +
//!   `<id>/component.wasm` pairs. Unset means no community connectors.
//! - `OPENSESAME_CONNECTOR_TRUSTED_DIGESTS` is a comma-separated list of
//!   `sha256:<hex>` digests. Setting the directory without pinning digests
//!   refuses boot: consent is a pinned digest, never a directory listing.
//! - Any unreadable, invalid, or unpinned entry refuses boot — a gateway
//!   never comes up "mostly" trusted.
//! - When the `wasm-connectors` feature is off, setting the directory also
//!   refuses boot rather than silently ignoring the operator's intent.

pub const ENV_CONNECTOR_DIR: &str = "OPENSESAME_CONNECTOR_DIR";
pub const ENV_TRUSTED_DIGESTS: &str = "OPENSESAME_CONNECTOR_TRUSTED_DIGESTS";

#[cfg(feature = "wasm-connectors")]
pub use enabled::load_wasm_connectors;

#[cfg(feature = "wasm-connectors")]
mod enabled {
    use super::{ENV_CONNECTOR_DIR, ENV_TRUSTED_DIGESTS};
    use anyhow::Context;
    use opensesame_connection_broker::ConnectionBroker;
    use opensesame_connector_host::manifest::ConnectorManifest;
    use opensesame_connector_host::wasm::{
        EgressRequest, EgressResponse, GuestLimits, HostEgress, WasmConnector,
    };
    use opensesame_connector_host::HostRuntime;
    use opensesame_domain::OrganizationId;
    use std::sync::Arc;

    /// Bridges guest `host-http` calls onto the connection broker — the one
    /// credential-injection funnel. The guest supplies a connection ref and
    /// a fenced destination; the broker resolves and injects the credential
    /// host-side and returns only the response.
    ///
    /// `sign`/`oauth` stay refused until the catalog promotion recorded in
    /// ADR 0065 §8 defines which keys and token endpoints a community
    /// connector may exercise. Refusing here is deliberate fail-closed
    /// posture, not a stub to quietly widen later.
    struct GatewayEgress {
        broker: Arc<ConnectionBroker>,
        organization: OrganizationId,
        handle: tokio::runtime::Handle,
    }

    impl GatewayEgress {
        fn run_json(
            &self,
            connection_id: &str,
            req: &EgressRequest,
        ) -> Result<serde_json::Value, String> {
            let body = if req.body.is_empty() {
                None
            } else {
                Some(
                    serde_json::from_slice(&req.body)
                        .map_err(|_| "request body must be JSON".to_owned())?,
                )
            };
            let broker = Arc::clone(&self.broker);
            let organization = self.organization;
            let connection = connection_id.to_owned();
            let method = req.method.clone();
            let url = req.url.clone();
            tokio::task::block_in_place(|| {
                self.handle.block_on(fetch_json(
                    broker,
                    organization,
                    connection,
                    method,
                    url,
                    body,
                ))
            })
        }
    }

    async fn fetch_json(
        broker: Arc<ConnectionBroker>,
        organization: OrganizationId,
        connection: String,
        method: String,
        url: String,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        broker
            .authorized_json(&organization, &connection, &method, &url, body)
            .await
            .map_err(|e| format!("egress failed: {e}"))
    }

    impl HostEgress for GatewayEgress {
        fn authorized_request(
            &self,
            connection_ref: &str,
            req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            let value = self.run_json(connection_ref, &req)?;
            Ok(EgressResponse {
                status: 200,
                headers: vec![],
                body: serde_json::to_vec(&value).unwrap_or_default(),
            })
        }

        fn sign(&self, _purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, String> {
            Err("host-crypto.sign is not yet open to community connectors (ADR 0065 §8)".into())
        }

        fn oauth_acquire(
            &self,
            _connection_ref: &str,
            _resource: Option<&str>,
            _audience: Option<&str>,
            _scopes: &[String],
        ) -> Result<u32, String> {
            Err("host-oauth.acquire is not yet open to community connectors (ADR 0065 §8)".into())
        }

        fn authenticated_request(
            &self,
            _connection_ref: &str,
            _token_handle: u32,
            _req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            Err(
                "host-oauth.authenticated-request is not yet open to community connectors (ADR 0065 §8)"
                    .into(),
            )
        }
    }

    /// Scan the operator's connector directory and register every entry.
    /// Every failure is a boot refusal.
    ///
    /// # Errors
    ///
    /// Returns an error on any unreadable entry, invalid manifest, unpinned
    /// or mismatched digest, or component that fails to load.
    pub fn load_wasm_connectors(
        host: &mut HostRuntime,
        broker: &Arc<ConnectionBroker>,
        organization: OrganizationId,
    ) -> anyhow::Result<()> {
        let Ok(dir) = std::env::var(ENV_CONNECTOR_DIR) else {
            return Ok(());
        };
        let digests = std::env::var(ENV_TRUSTED_DIGESTS).unwrap_or_default();
        let pinned: Vec<String> = digests
            .split(',')
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .collect();
        anyhow::ensure!(
            !pinned.is_empty(),
            "{ENV_CONNECTOR_DIR} is set but {ENV_TRUSTED_DIGESTS} pins nothing; \
             consent is a pinned digest (ADR 0065 §3)"
        );
        host.policy.trusted_digests.extend(pinned);

        let egress: Arc<dyn HostEgress> = Arc::new(GatewayEgress {
            broker: Arc::clone(broker),
            organization,
            handle: tokio::runtime::Handle::current(),
        });

        let mut loaded = 0usize;
        for entry in std::fs::read_dir(&dir).with_context(|| format!("read {dir}"))? {
            let path = entry?.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("connector.yaml");
            if !manifest_path.exists() {
                continue;
            }
            let manifest_text = std::fs::read_to_string(&manifest_path)
                .with_context(|| format!("read {}", manifest_path.display()))?;
            let manifest = ConnectorManifest::from_yaml(&manifest_text)
                .with_context(|| format!("parse {}", manifest_path.display()))?;
            let component_path = path.join("component.wasm");
            let component_bytes = std::fs::read(&component_path)
                .with_context(|| format!("read {}", component_path.display()))?;
            let connector = WasmConnector::load(
                manifest,
                &component_bytes,
                &host.policy,
                Arc::clone(&egress),
                GuestLimits::default(),
            )
            .map_err(|e| anyhow::anyhow!("load {}: {e}", path.display()))?;

            let id = opensesame_connector_host::Connector::id(&connector).to_owned();
            host.register_connector(Arc::new(connector))
                .map_err(|e| anyhow::anyhow!("register {id}: {e}"))?;
            host.bind_connection(id.clone(), &id)
                .map_err(|e| anyhow::anyhow!("bind connection {id}: {e}"))?;
            host.bind_provider(id.clone(), &id)
                .map_err(|e| anyhow::anyhow!("bind provider {id}: {e}"))?;
            tracing::info!(connector = %id, "wasm connector registered");
            loaded += 1;
        }
        tracing::info!(loaded, "wasm connector directory processed");
        Ok(())
    }
}

/// Feature-off build: the operator asking for connectors is a hard error —
/// never a silent no-op.
///
/// # Errors
///
/// Returns an error when `OPENSESAME_CONNECTOR_DIR` is set.
#[cfg(not(feature = "wasm-connectors"))]
pub fn load_wasm_connectors(
    _host: &mut opensesame_connector_host::HostRuntime,
    _broker: &std::sync::Arc<opensesame_connection_broker::ConnectionBroker>,
    _organization: opensesame_domain::OrganizationId,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var(ENV_CONNECTOR_DIR).is_err(),
        "{ENV_CONNECTOR_DIR} is set but this gateway was built without the \
         wasm-connectors feature; refusing to ignore operator intent"
    );
    Ok(())
}
