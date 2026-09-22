//! `OpenSesame` `TaskBus`: CloudEvents-shaped bus events behind a trait.
//!
//! - [`InMemoryTaskBus`] — default for unit tests and local-only runs.
//! - [`NatsJetStreamTaskBus`] — optional (`jetstream` feature); selected at
//!   runtime via `OPENSESAME_TASKBUS=nats` and/or `NATS_URL`.
//!
//! - [`UnavailableTaskBus`] — what a *secure* NATS profile becomes when its
//!   connection cannot be established: every call fails with the reason.
//!   Never a memory or plaintext fallback (ADR 0130, EXPLICIT-ENFORCEMENT).
//!
//! Subject namespace: `opensesame.events.>`. The NATS auth callout is the
//! server's native `$SYS.REQ.USER.AUTH` request in the AUTH account (see
//! `ops/nats/secure-client.conf`); `opensesame.callout.>` is only a reserved
//! application prefix and is not that protocol.

mod memory;
#[cfg(feature = "jetstream")]
mod nats;
#[cfg(feature = "jetstream")]
mod nats_connect;
#[cfg(feature = "jetstream")]
mod nats_policy;
#[cfg(feature = "jetstream")]
mod nats_transport;
#[cfg(feature = "jetstream")]
mod nats_transport_env;

pub use memory::{InMemoryTaskBus, UnavailableTaskBus};
#[cfg(feature = "jetstream")]
pub use nats::{NatsBusError, NatsJetStreamConfig, NatsJetStreamTaskBus};
#[cfg(feature = "jetstream")]
pub use nats_connect::{event_code, BusHealth, InjectedMaterial, NatsRole};
#[cfg(feature = "jetstream")]
pub use nats_policy::{
    IdentityRef, NatsAuth, NatsServerName, NatsTransport, NatsTransportPolicy, NatsTransportPublic,
    NatsTransportSource, NatsTransportView, TrustRef,
};
#[cfg(feature = "jetstream")]
pub use nats_transport::NatsTransportSpec;
#[cfg(feature = "jetstream")]
pub use nats_transport_env::url_hosts;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// `JetStream` stream that captures `opensesame.events.>`.
pub const DEFAULT_STREAM_NAME: &str = "OPENSESAME_EVENTS";
/// Subject prefix for identity / host bus events.
pub const DEFAULT_SUBJECT_PREFIX: &str = "opensesame.events";
/// Durable pull consumer used by workers that drain the bus.
pub const DEFAULT_CONSUMER_NAME: &str = "opensesame-worker";
/// Durable consumer for Host backup wakes.
pub const BACKUP_CONSUMER_NAME: &str = "opensesame-backup";
/// Durable consumer for GitHub webhook wakes.
pub const GITHUB_WEBHOOK_CONSUMER_NAME: &str = "opensesame-github-wh";
/// Reserved *application* subject prefix. Not the NATS auth-callout wire:
/// that is the server's `$SYS.REQ.USER.AUTH` (`ops/nats/secure-client.conf`).
pub const CALLOUT_SUBJECT_PREFIX: &str = "opensesame.callout";
/// System subjects Host alone publishes (not callout-user publishable).
pub const SYSTEM_SUBJECT_PREFIX: &str = "opensesame.events.system";

mod envelope;
mod validate;
pub use envelope::{open_event_data, seal_event_data, sealed_to_json, SealedEventData};
pub use validate::{is_system_event_type, system_event_subject, validate_nats_url};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BusEvent {
    pub id: String,
    pub specversion: String,
    pub source: String,
    pub r#type: String,
    pub time: String,
    pub data: Value,
}

impl BusEvent {
    /// `CloudEvents` 1.0 helper used by producers (outbox drain, Host publishers).
    pub fn cloud_event(
        id: impl Into<String>,
        source: impl Into<String>,
        r#type: impl Into<String>,
        time: impl Into<String>,
        data: Value,
    ) -> Self {
        Self {
            id: id.into(),
            specversion: "1.0".into(),
            source: source.into(),
            r#type: r#type.into(),
            time: time.into(),
            data,
        }
    }

    /// Subject under `opensesame.events.>` for this event type.
    #[must_use]
    pub fn subject(&self, prefix: &str) -> String {
        event_subject(prefix, &self.r#type)
    }
}

/// Build `opensesame.events.{type}` (type may contain dots).
#[must_use]
pub fn event_subject(prefix: &str, event_type: &str) -> String {
    let prefix = prefix.trim_end_matches('.');
    let ty = event_type.trim_start_matches('.');
    format!("{prefix}.{ty}")
}

#[async_trait]
pub trait TaskBus: Send + Sync {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()>;
    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>>;
}

/// Which adapter `from_env` should construct.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskBusBackend {
    Memory,
    Nats,
}

impl TaskBusBackend {
    /// Resolve from `OPENSESAME_TASKBUS` and `NATS_URL`.
    ///
    /// - `OPENSESAME_TASKBUS=memory` → always memory
    /// - `OPENSESAME_TASKBUS=nats` → nats (requires `NATS_URL`)
    /// - unset + `NATS_URL` set → nats
    /// - otherwise → memory (unit-test default)
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_env() -> anyhow::Result<Self> {
        let explicit = std::env::var("OPENSESAME_TASKBUS")
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty());
        let nats_url = std::env::var("NATS_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        match explicit.as_deref() {
            Some("memory" | "inmemory" | "in-memory") => Ok(Self::Memory),
            Some("nats" | "jetstream") => {
                if nats_url.is_none() {
                    anyhow::bail!("OPENSESAME_TASKBUS=nats requires NATS_URL");
                }
                Ok(Self::Nats)
            }
            Some(other) => {
                anyhow::bail!("unknown OPENSESAME_TASKBUS={other}; expected memory|nats")
            }
            None => {
                if nats_url.is_some() {
                    Ok(Self::Nats)
                } else {
                    Ok(Self::Memory)
                }
            }
        }
    }
}

/// Construct a `TaskBus` from environment (memory by default).
///
/// Precedence for callers that also load durable Host config should resolve
/// env first, then stored URL — see gateway `taskbus_config`. The NATS
/// transport comes from `OPENSESAME_NATS_*` (plaintext loopback when unset).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub async fn create_from_env() -> anyhow::Result<Arc<dyn TaskBus>> {
    match TaskBusBackend::from_env()? {
        TaskBusBackend::Memory => Ok(Arc::new(InMemoryTaskBus::default())),
        TaskBusBackend::Nats => {
            let url = std::env::var("NATS_URL")?;
            create_nats(&url).await
        }
    }
}

/// Connect a `JetStream` `TaskBus` to an explicit URL with the transport
/// resolved from `OPENSESAME_NATS_*` (Host operator ping / apply). A secure
/// profile is never provisioned here; the plaintext loopback profile keeps
/// creating its stream and consumer on connect (legacy local behaviour).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub async fn create_nats(nats_url: &str) -> anyhow::Result<Arc<dyn TaskBus>> {
    #[cfg(feature = "jetstream")]
    {
        let transport = NatsTransportSpec::from_env()?.unwrap_or_else(NatsTransportSpec::plaintext);
        let provision = !transport.is_secure();
        create_with(nats_url, transport, NatsRole::Host, provision).await
    }
    #[cfg(not(feature = "jetstream"))]
    {
        let _ = nats_url;
        anyhow::bail!("opensesame-task-bus was built without the `jetstream` feature");
    }
}

/// Connect a `JetStream` `TaskBus` with an explicit transport, role and
/// provisioning decision. Every Host constructor goes through here.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
#[cfg(feature = "jetstream")]
pub async fn create_with(
    nats_url: &str,
    transport: NatsTransportSpec,
    role: NatsRole,
    provision: bool,
) -> anyhow::Result<Arc<dyn TaskBus>> {
    let bus = NatsJetStreamTaskBus::connect(NatsJetStreamConfig {
        nats_url: nats_url.to_string(),
        transport,
        role,
        provision,
        ..NatsJetStreamConfig::default()
    })
    .await?;
    Ok(Arc::new(bus))
}

/// The `JetStream` configuration for the Host *backup wake* consumer: the
/// durable `opensesame-backup` filtered to `opensesame.events.system.>`. One
/// definition so the provisioning action and the runtime consumer cannot
/// drift apart (and so a backup identity never opens the worker consumer).
#[cfg(feature = "jetstream")]
#[must_use]
pub fn backup_consumer_config(
    nats_url: &str,
    transport: NatsTransportSpec,
    role: NatsRole,
    provision: bool,
) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        nats_url: nats_url.to_string(),
        consumer_name: BACKUP_CONSUMER_NAME.to_string(),
        filter_subject: Some(format!("{SYSTEM_SUBJECT_PREFIX}.>")),
        fetch_expires: std::time::Duration::from_secs(2),
        transport,
        role,
        provision,
        ..NatsJetStreamConfig::default()
    }
}

/// Create the backup wake consumer as part of the one-time provisioning
/// action. Separate from [`create_with`] because the worker consumer and the
/// backup consumer are two durables and a runtime role creates neither.
///
/// # Errors
///
/// Returns an error when the connection or the consumer creation fails.
#[cfg(feature = "jetstream")]
pub async fn provision_backup_consumer(
    nats_url: &str,
    transport: NatsTransportSpec,
) -> anyhow::Result<()> {
    NatsJetStreamTaskBus::connect(backup_consumer_config(
        nats_url,
        transport,
        NatsRole::Provisioner,
        true,
    ))
    .await?;
    Ok(())
}

/// Build memory or nats from explicit backend + optional URL.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub async fn create(
    backend: TaskBusBackend,
    nats_url: Option<&str>,
) -> anyhow::Result<Arc<dyn TaskBus>> {
    match backend {
        TaskBusBackend::Memory => Ok(Arc::new(InMemoryTaskBus::default())),
        TaskBusBackend::Nats => {
            let url = nats_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .ok_or_else(|| anyhow::anyhow!("nats backend requires nats_url"))?;
            create_nats(url).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_event(id: &str) -> BusEvent {
        BusEvent::cloud_event(
            id,
            "opensesame/test",
            "principal.created",
            "2026-08-17T00:00:00Z",
            json!({"principal_id": "prn_1"}),
        )
    }

    #[tokio::test]
    async fn in_memory_publish_drain_fifo() {
        let bus = InMemoryTaskBus::default();
        bus.publish(sample_event("1")).await.unwrap();
        bus.publish(sample_event("2")).await.unwrap();
        let batch = bus.drain(1).await.unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].id, "1");
        let rest = bus.drain(10).await.unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, "2");
        assert!(bus.drain(10).await.unwrap().is_empty());
    }

    #[test]
    fn event_subject_joins_prefix_and_type() {
        assert_eq!(
            event_subject("opensesame.events", "credential.rotation.requested"),
            "opensesame.events.credential.rotation.requested"
        );
        assert_eq!(
            sample_event("x").subject(DEFAULT_SUBJECT_PREFIX),
            "opensesame.events.principal.created"
        );
    }

    #[test]
    fn backend_from_env_matrix() {
        let saved_taskbus = std::env::var_os("OPENSESAME_TASKBUS");
        let saved_nats = std::env::var_os("NATS_URL");
        let restore = || {
            match &saved_taskbus {
                Some(v) => std::env::set_var("OPENSESAME_TASKBUS", v),
                None => std::env::remove_var("OPENSESAME_TASKBUS"),
            }
            match &saved_nats {
                Some(v) => std::env::set_var("NATS_URL", v),
                None => std::env::remove_var("NATS_URL"),
            }
        };

        std::env::remove_var("OPENSESAME_TASKBUS");
        std::env::remove_var("NATS_URL");
        assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Memory);

        std::env::set_var("NATS_URL", "nats://127.0.0.1:4222");
        assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Nats);

        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Memory);

        std::env::set_var("OPENSESAME_TASKBUS", "nats");
        assert!(TaskBusBackend::from_env().is_ok());

        std::env::remove_var("NATS_URL");
        assert!(TaskBusBackend::from_env().is_err());

        std::env::set_var("OPENSESAME_TASKBUS", "bogus");
        assert!(TaskBusBackend::from_env().is_err());

        restore();
    }
}
