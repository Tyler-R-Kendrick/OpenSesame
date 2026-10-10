//! Relay profile (ADR 0181).
//!
//! Serves `GET /health/live`, `GET /health/relay`, and the vault-relay slot
//! routes. Every other path is absent, including operator transport
//! administration. The process does not open the Host database. A browser
//! is admitted by the slot key; this slice checks that key and refuses a
//! binding document that is not empty `vault_relay` snapshot authority.
//! `GET /health/relay` advertises that authority: purpose `vault_relay`,
//! the document (`empty` or `vault_relay`), and `durable: true`.
//! Native `mtls_required` admits certificated peers through the installed
//! `vault_relay` binding set only (`service_admit`), not the Host resolver.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, State};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use opensesame_host_core::http_security::ciphertext_drive_cors_layer;

use crate::config::Args;

pub const SNAPSHOT_FORMAT: &str = "opensesame-vault-drive-snapshot";
pub(crate) const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const SLOT_KEY: &str = "x-opensesame-slot-key";
pub(crate) const PRINCIPAL: &str = "x-opensesame-principal";
pub(crate) const OWNER_KIND: &str = "x-opensesame-owner-kind";
pub(crate) const ORG_ROLE: &str = "x-opensesame-org-role";

pub(crate) struct Slot {
    pub(crate) key_sha256: String,
    pub(crate) generation: u64,
    pub(crate) snapshot: Value,
}

pub(crate) struct DirEntry {
    pub(crate) owner_kind: String,
    pub(crate) owner: String,
    pub(crate) slug: String,
    pub(crate) principal: String,
}

#[derive(Default)]
pub(crate) struct Store {
    pub(crate) slots: BTreeMap<String, Slot>,
    /// Addresses created or claimed, keyed `owner/slug`.
    pub(crate) directory: BTreeMap<String, DirEntry>,
    /// Owner label → `user` | `organization` (one namespace for handles and slugs).
    pub(crate) owners: BTreeMap<String, String>,
}

/// Active mTLS profile, when `OPENSESAME_RELAY_TRANSPORT=mtls_required`.
#[derive(Clone)]
pub(crate) struct RelayMtls {
    pub(crate) generations: std::sync::Arc<opensesame_transport_security::TransportGenerations>,
}

#[derive(Clone)]
pub(crate) struct RelayState {
    pub(crate) store: Shared,
    /// Empty, or entirely purpose `vault_relay`, for the life of this process.
    pub(crate) bindings: opensesame_domain::transport::ServiceBindingSet,
    pub(crate) mtls: Option<RelayMtls>,
    /// When set, org directory and publish policy use registration JWTs only.
    pub(crate) registration: Option<registration::Verifier>,
}

pub(crate) type Shared = Arc<Mutex<Store>>;

/// Bindings relay profile installs: empty when no file is set.
///
/// # Errors
///
/// The file cannot be read, or it is not an empty set and not entirely
/// purpose `vault_relay` limited to the two snapshot operations.
pub fn install_relay_bindings(
    json: Option<&str>,
) -> Result<opensesame_domain::transport::ServiceBindingSet, String> {
    use opensesame_domain::transport::{validate_relay_profile, ServiceBindingSet};
    let set = match json {
        None => ServiceBindingSet::empty(),
        Some(body) => ServiceBindingSet::parse_json(body).map_err(|err| err.to_string())?,
    };
    validate_relay_profile(&set).map_err(|err| err.to_string())?;
    Ok(set)
}

/// Validate the document relay profile would install.
///
/// # Errors
///
/// The same refusals as [`install_relay_bindings`].
pub fn bindings_for_relay(json: Option<&str>) -> Result<(), String> {
    install_relay_bindings(json).map(|_| ())
}

pub(crate) fn load_bindings() -> anyhow::Result<opensesame_domain::transport::ServiceBindingSet> {
    let path = std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE")
        .ok()
        .filter(|value| !value.is_empty());
    let json = match path.as_ref() {
        None => None,
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|err| anyhow::anyhow!("OPENSESAME_SERVICE_BINDINGS_FILE: {err}"))?,
        ),
    };
    let set = install_relay_bindings(json.as_deref()).map_err(anyhow::Error::msg)?;
    tracing::info!(
        source = if path.is_none() { "default" } else { "file" },
        revision = set.revision,
        bindings = set.bindings.len(),
        purpose = "vault_relay",
        "installed vault_relay bindings"
    );
    Ok(set)
}

pub(crate) fn router(store: Shared) -> Router {
    router_with(
        store,
        install_relay_bindings(None).expect("empty vault_relay bindings install"),
        None,
        None,
    )
}

pub(crate) fn router_with(
    store: Shared,
    bindings: opensesame_domain::transport::ServiceBindingSet,
    mtls: Option<RelayMtls>,
    registration: Option<registration::Verifier>,
) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/relay", get(relay_health))
        .route(
            "/v1/vault-relay/{owner}/{slug}/snapshot",
            get(routes::get_snapshot).put(routes::put_snapshot),
        )
        .route(
            "/v1/org-vaults",
            get(routes::list_org_vaults).post(routes::create_org_vault),
        )
        .layer(DefaultBodyLimit::max(MAX_SNAPSHOT_BYTES))
        .layer(ciphertext_drive_cors_layer(&crate::config::cors_origins()))
        .with_state(RelayState {
            store,
            bindings,
            mtls,
            registration,
        })
}

pub(crate) async fn live(State(state): State<RelayState>) -> &'static str {
    // The set is router state, not only a startup log line. A request cannot
    // be served by a process that dropped the document it installed.
    tracing::debug!(
        revision = state.bindings.revision,
        bindings = state.bindings.bindings.len(),
        "relay profile is holding the installed vault_relay bindings"
    );
    "ok"
}

/// Profile advertisement. Not operator transport administration: the relay
/// does not serve `PUT /api/v1/operator/transport/bindings`.
pub(crate) async fn relay_health(State(state): State<RelayState>) -> Json<Value> {
    let document = if state.bindings.bindings.is_empty() {
        "empty"
    } else {
        "vault_relay"
    };
    Json(json!({
        "profile": "relay",
        "purpose": "vault_relay",
        "bindings": "vault_relay",
        "document": document,
        "durable": true,
    }))
}

/// Serve relay profile until the listener stops.
///
/// # Errors
///
/// The binding document is refused, the listen address is not allowed, or
/// the socket cannot be bound.
pub async fn run(args: &Args) -> anyhow::Result<()> {
    use transport::{bind_secure, load_secure, RelayTransport};

    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    let store = Arc::new(Mutex::new(Store::default()));
    let profile =
        RelayTransport::parse(&|name| std::env::var(name).ok()).map_err(anyhow::Error::new)?;
    match profile {
        RelayTransport::Plain => {
            let bindings = load_bindings()?;
            let registration = registration::Verifier::from_env().map_err(anyhow::Error::msg)?;
            tracing::info!(%listen, profile = "relay", transport = "plain", "opensesame gateway relay listening");
            let listener = tokio::net::TcpListener::bind(args.listen)
                .await
                .map_err(|err| anyhow::anyhow!("bind {listen}: {err}"))?;
            tracing::info!(
                installed = bindings.bindings.len(),
                revision = bindings.revision,
                "relay profile is serving the installed vault_relay bindings"
            );
            axum::serve(listener, router_with(store, bindings, None, registration)).await?;
        }
        RelayTransport::MtlsRequired => {
            let secure =
                load_secure(&listen, &|name| std::env::var(name).ok()).map_err(|error| {
                    anyhow::anyhow!(
                        "relay mtls_required refused to start: {error} [{}]",
                        error.code()
                    )
                })?;
            let bindings = (*secure.bindings).clone();
            let mtls = RelayMtls {
                generations: Arc::clone(&secure.generations),
            };
            let registration = registration::Verifier::from_env().map_err(anyhow::Error::msg)?;
            let app = router_with(store, bindings, Some(mtls), registration).layer(
                axum::middleware::from_fn_with_state(
                    Arc::clone(&secure.generations),
                    opensesame_transport_security::enforce_current_generation,
                ),
            );
            let listener = bind_secure(&secure).await.map_err(anyhow::Error::new)?;
            tracing::info!(
                listen = %listener.local_addr(),
                profile = "relay",
                transport = "mtls_required",
                installed = secure.bindings.bindings.len(),
                "opensesame gateway relay listening"
            );
            listener.serve(app).await.map_err(anyhow::Error::new)?;
        }
    }
    Ok(())
}

mod admit;
mod identity;
mod registration;
mod routes;
mod service_admit;
mod transport;

#[cfg(test)]
mod directory_tests;
#[cfg(test)]
mod mtls_tests;
#[cfg(test)]
mod registration_attacks;
#[cfg(test)]
mod registration_tests;
#[cfg(test)]
mod snapshot_tests;
#[cfg(test)]
mod test_support;
