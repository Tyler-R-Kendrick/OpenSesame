//! Building `async_nats::ConnectOptions` from a [`NatsTransportSpec`].
//!
//! One path for every NATS client the Host opens: the verifier is
//! `opensesame_transport_security::client_config` (WebPKI reference identity
//! or exact SPIFFE ID against the configured bundle), so a NATS connection
//! is checked by the same code as every other outbound TLS connection.
//!
//! On a TLS profile the client is told to `require_tls` (async-nats then
//! upgrades every connection — first and every reconnect — regardless of the
//! server's INFO), to `ignore_discovered_servers` (an `INFO.connect_urls`
//! entry can never add an egress destination the operator did not list) and
//! to `retain_servers_order` (fail over only along the operator's list).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_nats::{ConnectOptions, Event};
use opensesame_domain::transport::{TransportError, TrustProfileRef};
use opensesame_transport_security::env::read_pem_identity;
use opensesame_transport_security::{
    client_config, ClientProfile, NativeIdentitySpec, NativeTrustSpec, ServerNamePolicy,
    TlsIdentity, TrustBundle,
};
use serde::{Deserialize, Serialize};

use crate::nats_policy::{NatsAuth, NatsServerName};
use crate::nats_transport::NatsTransportSpec;

/// The least-privilege identity a client runs as. Decides the client name
/// the server sees and which `JetStream` API calls the adapter makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatsRole {
    /// Host runtime: publishes `opensesame.events.>` and drains its own
    /// durable consumer. Never creates streams.
    Host,
    /// Publish only (`opensesame.events.>`); no `$JS.API.*` at all.
    Publisher,
    /// Durable pull on its own consumer only.
    Consumer,
    /// Backup wakes: durable pull filtered to `opensesame.events.system.>`.
    Backup,
    /// One-time stream/consumer creation.
    Provisioner,
    /// Auth-callout responder (`$SYS.REQ.USER.AUTH` in the AUTH account).
    /// Never a `TaskBus`; listed so the name and the permission set exist.
    Callout,
}

impl NatsRole {
    #[must_use]
    pub fn client_name(self) -> &'static str {
        match self {
            Self::Host => "opensesame-host",
            Self::Publisher => "opensesame-publisher",
            Self::Consumer => "opensesame-consumer",
            Self::Backup => "opensesame-backup",
            Self::Provisioner => "opensesame-provisioner",
            Self::Callout => "opensesame-callout",
        }
    }

    /// Whether this role drains a durable consumer.
    #[must_use]
    pub fn consumes(self) -> bool {
        matches!(self, Self::Host | Self::Consumer | Self::Backup | Self::Provisioner)
    }

    /// Whether this role publishes events.
    #[must_use]
    pub fn publishes(self) -> bool {
        matches!(self, Self::Host | Self::Publisher | Self::Provisioner)
    }
}

/// Connection health as observed through the client's event callback.
/// Reason codes only — never a credential, never a URL with userinfo.
#[derive(Default)]
pub struct BusHealth {
    connected: AtomicBool,
    disconnects: AtomicU64,
    reconnects: AtomicU64,
    last_event: Mutex<Option<String>>,
}

impl BusHealth {
    #[must_use]
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn disconnects(&self) -> u64 {
        self.disconnects.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn reconnects(&self) -> u64 {
        self.reconnects.load(Ordering::SeqCst)
    }

    /// The last reason code (`connected`, `disconnected`, `closed`,
    /// `server_error:authorization_violation`, ...).
    #[must_use]
    pub fn last_event(&self) -> Option<String> {
        self.last_event.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub(crate) fn record(&self, event: &Event) {
        let code = event_code(event);
        match event {
            Event::Connected => {
                if self.connected.swap(true, Ordering::SeqCst) || self.disconnects() > 0 {
                    self.reconnects.fetch_add(1, Ordering::SeqCst);
                }
            }
            Event::Disconnected | Event::Closed => {
                self.connected.store(false, Ordering::SeqCst);
                self.disconnects.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }
        if let Ok(mut guard) = self.last_event.lock() {
            *guard = Some(code);
        }
    }
}

/// A stable, secret-free reason code for a client event.
#[must_use]
pub fn event_code(event: &Event) -> String {
    match event {
        Event::Connected => "connected".into(),
        Event::Disconnected => "disconnected".into(),
        Event::LameDuckMode => "lame_duck".into(),
        Event::Draining => "draining".into(),
        Event::Closed => "closed".into(),
        Event::SlowConsumer(_) => "slow_consumer".into(),
        Event::ServerError(async_nats::ServerError::AuthorizationViolation) => {
            "server_error:authorization_violation".into()
        }
        Event::ServerError(async_nats::ServerError::SlowConsumer(_)) => "server_error:slow_consumer".into(),
        Event::ServerError(async_nats::ServerError::Other(_)) => "server_error:other".into(),
        Event::ClientError(async_nats::ClientError::MaxReconnects) => "client_error:max_reconnects".into(),
        Event::ClientError(async_nats::ClientError::ServerNotInPool) => "client_error:server_not_in_pool".into(),
        Event::ClientError(async_nats::ClientError::Other(_)) => "client_error:other".into(),
    }
}

/// Material loaded for one connection. Dropped with the options.
pub(crate) struct Material {
    pub identity: Option<Arc<TlsIdentity>>,
    pub trust: Option<TrustBundle>,
}

/// Hook for callers that hold material the env resolver cannot load
/// (managed certificates, SPIFFE SVIDs): supply it here instead.
#[derive(Clone, Default)]
pub struct InjectedMaterial {
    pub identity: Option<Arc<TlsIdentity>>,
    pub trust: Option<TrustBundle>,
}

fn load_identity(spec: &NativeIdentitySpec) -> Result<Arc<TlsIdentity>, TransportError> {
    match spec {
        NativeIdentitySpec::PemFiles { cert, key } => read_pem_identity(cert, key).map(Arc::new),
        NativeIdentitySpec::ManagedCertificate { .. } | NativeIdentitySpec::Spiffe { .. } => {
            Err(TransportError::SourceUnsupported)
        }
    }
}

fn load_trust(
    name: &str,
    spec: &NativeTrustSpec,
    crl: Option<&Path>,
) -> Result<TrustBundle, TransportError> {
    match spec {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(path)
                .map_err(|e| TransportError::MalformedConfiguration(format!("trust bundle file: {e}")))?;
            let bundle = TrustBundle::from_pem(TrustProfileRef::new(name)?, *kind, &pem)?;
            match crl {
                Some(crl_path) => {
                    let crl_pem = std::fs::read(crl_path)
                        .map_err(|e| TransportError::MalformedConfiguration(format!("crl file: {e}")))?;
                    bundle.with_crls(&crl_pem)
                }
                None => Ok(bundle),
            }
        }
        NativeTrustSpec::SpiffeTrustDomain { .. } => Err(TransportError::SourceUnsupported),
    }
}

/// Load (or take injected) material for a *normalized* spec.
pub(crate) fn load_material(
    spec: &NatsTransportSpec,
    injected: &InjectedMaterial,
) -> Result<Material, TransportError> {
    if !spec.is_secure() {
        return Ok(Material { identity: None, trust: None });
    }
    let trust = match (&injected.trust, &spec.locators.trust, &spec.transport.server_trust) {
        (Some(bundle), _, _) => bundle.clone(),
        (None, Some(locator), Some(reference)) => {
            load_trust(&reference.name, locator, spec.locators.crl_file.as_deref())?
        }
        _ => return Err(TransportError::TrustUnknown),
    };
    let identity = match (&injected.identity, &spec.locators.identity, &spec.transport.client_identity) {
        (Some(identity), _, _) => Some(Arc::clone(identity)),
        (None, Some(locator), Some(_)) => Some(load_identity(locator)?),
        (None, None, Some(_)) => return Err(TransportError::IdentityMissing),
        (None, _, None) => None,
    };
    Ok(Material { identity, trust: Some(trust) })
}

/// Build the rustls configuration through transport-security.
pub(crate) fn tls_config(
    spec: &NatsTransportSpec,
    material: &Material,
) -> Result<async_nats::rustls::ClientConfig, TransportError> {
    let trust = material.trust.clone().ok_or(TransportError::TrustUnknown)?;
    let server_name = match &spec.transport.server_name {
        Some(NatsServerName::Dns(name)) => ServerNamePolicy::Dns(name.clone()),
        Some(NatsServerName::SpiffeId(id)) => ServerNamePolicy::SpiffeId(id.clone()),
        None => return Err(TransportError::MalformedConfiguration("server name unresolved".into())),
    };
    client_config(&ClientProfile {
        server_trust: trust,
        server_name,
        identity: material.identity.clone(),
        min_version: spec.transport.min_version,
    })
}

fn read_seed(path: &Path) -> Result<String, TransportError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| TransportError::MalformedConfiguration(format!("nkey seed file: {e}")))?;
    let seed = raw.trim().to_owned();
    if !seed.starts_with('S') || seed.len() < 20 {
        return Err(TransportError::MalformedConfiguration("nkey seed file does not hold a seed".into()));
    }
    Ok(seed)
}

/// Build the connect options for a normalized spec.
///
/// # Errors
///
/// `TransportError` for missing/invalid material or a policy the client
/// cannot honour; the connection is never attempted in that case.
pub async fn connect_options(
    spec: &NatsTransportSpec,
    role: NatsRole,
    injected: &InjectedMaterial,
    health: Arc<BusHealth>,
) -> Result<ConnectOptions, TransportError> {
    let material = load_material(spec, injected)?;
    let mut options = ConnectOptions::new()
        .name(role.client_name())
        .max_reconnects(spec.max_reconnects)
        .event_callback(move |event| {
            let health = Arc::clone(&health);
            async move {
                health.record(&event);
                tracing::info!(code = %event_code(&event), role = role.client_name(), "nats client event");
            }
        });
    if spec.is_secure() {
        let config = tls_config(spec, &material)?;
        options = options
            .require_tls(true)
            .tls_client_config(config)
            .ignore_discovered_servers()
            .retain_servers_order();
        if spec.transport.tls_first {
            options = options.tls_first();
        }
    }
    options = match &spec.auth {
        NatsAuth::None => options,
        NatsAuth::Nkey { .. } => {
            let path = spec.locators.nkey_seed_file.as_deref().ok_or(TransportError::IdentityMissing)?;
            options.nkey(read_seed(path)?)
        }
        NatsAuth::Creds { .. } => {
            let path = spec.locators.creds_file.as_deref().ok_or(TransportError::IdentityMissing)?;
            options
                .credentials_file(path)
                .await
                .map_err(|e| TransportError::MalformedConfiguration(format!("credentials file: {e}")))?
        }
    };
    Ok(options)
}
