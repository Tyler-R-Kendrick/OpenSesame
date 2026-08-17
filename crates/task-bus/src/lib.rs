//! OpenSesame TaskBus: CloudEvents-shaped bus events behind a trait.
//!
//! - [`InMemoryTaskBus`] — default for unit tests and local-only runs.
//! - [`NatsJetStreamTaskBus`] — optional (`jetstream` feature); selected at
//!   runtime via `OPENSESAME_TASKBUS=nats` and/or `NATS_URL`.
//!
//! Subject namespace: `opensesame.events.>` (auth callout reserved under
//! `opensesame.callout.>` — not implemented here).

mod memory;
#[cfg(feature = "jetstream")]
mod nats;

pub use memory::InMemoryTaskBus;
#[cfg(feature = "jetstream")]
pub use nats::{NatsJetStreamConfig, NatsJetStreamTaskBus};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// JetStream stream that captures `opensesame.events.>`.
pub const DEFAULT_STREAM_NAME: &str = "OPENSESAME_EVENTS";
/// Subject prefix for identity / host bus events.
pub const DEFAULT_SUBJECT_PREFIX: &str = "opensesame.events";
/// Durable pull consumer used by workers that drain the bus.
pub const DEFAULT_CONSUMER_NAME: &str = "opensesame-worker";
/// Reserved subject prefix for Host NATS auth callout (WP-H); not used here.
pub const CALLOUT_SUBJECT_PREFIX: &str = "opensesame.callout";

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
    /// CloudEvents 1.0 helper used by producers (outbox drain, Host publishers).
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
    pub fn subject(&self, prefix: &str) -> String {
        event_subject(prefix, &self.r#type)
    }
}

/// Build `opensesame.events.{type}` (type may contain dots).
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
            Some("memory") | Some("inmemory") | Some("in-memory") => Ok(Self::Memory),
            Some("nats") | Some("jetstream") => {
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

/// Construct a TaskBus from environment (memory by default).
pub async fn create_from_env() -> anyhow::Result<Arc<dyn TaskBus>> {
    match TaskBusBackend::from_env()? {
        TaskBusBackend::Memory => Ok(Arc::new(InMemoryTaskBus::default())),
        TaskBusBackend::Nats => {
            #[cfg(feature = "jetstream")]
            {
                let url = std::env::var("NATS_URL")?;
                let bus = NatsJetStreamTaskBus::connect(NatsJetStreamConfig {
                    nats_url: url,
                    ..NatsJetStreamConfig::default()
                })
                .await?;
                Ok(Arc::new(bus))
            }
            #[cfg(not(feature = "jetstream"))]
            {
                anyhow::bail!(
                    "OPENSESAME_TASKBUS=nats / NATS_URL set but opensesame-task-bus \
                     was built without the `jetstream` feature"
                );
            }
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
    fn backend_defaults_to_memory_without_env() {
        // Avoid clobbering a developer's real env if set; only assert the
        // documented default when neither var is present.
        let taskbus = std::env::var_os("OPENSESAME_TASKBUS");
        let nats = std::env::var_os("NATS_URL");
        if taskbus.is_none() && nats.is_none() {
            assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Memory);
        }
    }
}
