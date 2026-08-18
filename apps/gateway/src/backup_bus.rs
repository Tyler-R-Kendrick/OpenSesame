//! Backup TaskBus wakes (system subjects). Outbox remains SoT; bus accelerates.
//!
//! When the Host TaskBus backend is NATS, a dedicated durable consumer
//! (`opensesame-backup`) drains `opensesame.events.system.>` and wakes the
//! outbox actor. The actor's SQLite claim/lease remains the only claim path —
//! JetStream never becomes a second ledger. Memory backend skips this consumer
//! and relies on `backup_notify` + tick only (shared in-memory bus must not be
//! drained here or it would steal sync/rotation events).

use opensesame_task_bus::{
    BusEvent, NatsJetStreamConfig, NatsJetStreamTaskBus, TaskBus, TaskBusBackend,
    BACKUP_CONSUMER_NAME, DEFAULT_STREAM_NAME, DEFAULT_SUBJECT_PREFIX, SYSTEM_SUBJECT_PREFIX,
};
use serde_json::json;
use std::time::Duration;

use crate::app_state::AppState;
use crate::taskbus_config;

pub const BACKUP_WAKE_TYPE: &str = "system.backup.wake";

/// Publish a wake after outbox append. Failures are logged — tick still drains.
pub async fn publish_backup_wake(st: &AppState, outbox_id: &str) {
    let event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        "opensesame/gateway/backup",
        BACKUP_WAKE_TYPE,
        chrono::Utc::now().to_rfc3339(),
        json!({
            "outbox_id": outbox_id,
            "organization_id": st.connection_organization.to_string(),
        }),
    );
    debug_assert!(
        event.subject(DEFAULT_SUBJECT_PREFIX).starts_with(SYSTEM_SUBJECT_PREFIX),
        "backup wakes must land under {}",
        SYSTEM_SUBJECT_PREFIX
    );
    let bus = st.task_bus.read().await;
    if let Err(error) = bus.publish(event).await {
        tracing::warn!(%error, outbox_id, "backup TaskBus wake publish failed; tick will drain");
    }
    // Always notify the in-process actor: memory path has no JetStream consumer;
    // nats path gets an extra wake from the durable consumer as well — claim/lease
    // makes concurrent passes safe.
    st.backup_notify.notify_one();
}

/// Drain system wakes from JetStream and wake the outbox actor (nats only).
pub async fn run_system_wake_consumer(state: AppState) {
    let Ok(resolved) = taskbus_config::resolve(&state.db).await else {
        return;
    };
    if !matches!(resolved.backend, TaskBusBackend::Nats) {
        tracing::info!("backup JetStream wake consumer idle (TaskBus backend is not nats)");
        return;
    }
    let Some(url) = resolved.nats_url.as_deref() else {
        return;
    };

    let filter = format!("{}.>", SYSTEM_SUBJECT_PREFIX.trim_end_matches('.'));
    let bus = match NatsJetStreamTaskBus::connect(NatsJetStreamConfig {
        nats_url: url.to_string(),
        stream_name: DEFAULT_STREAM_NAME.into(),
        subject_prefix: DEFAULT_SUBJECT_PREFIX.into(),
        consumer_name: BACKUP_CONSUMER_NAME.into(),
        filter_subject: Some(filter),
        fetch_expires: Duration::from_secs(2),
    })
    .await
    {
        Ok(bus) => bus,
        Err(error) => {
            tracing::warn!(%error, "backup JetStream wake consumer failed to connect");
            return;
        }
    };
    tracing::info!("backup JetStream wake consumer started");
    loop {
        match bus.drain(32).await {
            Ok(events) if !events.is_empty() => {
                tracing::debug!(count = events.len(), "system TaskBus wakes received");
                state.backup_notify.notify_one();
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "backup JetStream drain failed; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_publisher_does_not_use_deployment_seal() {
        let src = include_str!("backup_bus.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(production.contains("system.backup.wake"));
        assert!(!production.contains("OPENSESAME_CONNECTION_KEY"));
        assert!(!production.contains("std::env::var(\"OPENSESAME_CONNECTION"));
    }

    #[test]
    fn wake_type_is_system_prefixed() {
        assert!(BACKUP_WAKE_TYPE.starts_with("system."));
        let subject = opensesame_task_bus::event_subject(
            opensesame_task_bus::DEFAULT_SUBJECT_PREFIX,
            BACKUP_WAKE_TYPE,
        );
        assert!(subject.starts_with(opensesame_task_bus::SYSTEM_SUBJECT_PREFIX));
    }

    #[tokio::test]
    async fn publish_wake_lands_on_memory_bus() {
        let _guard = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let mut state = crate::app_state::build(crate::config::Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let mem = std::sync::Arc::new(opensesame_task_bus::InMemoryTaskBus::default());
        let as_dyn: std::sync::Arc<dyn opensesame_task_bus::TaskBus> = mem.clone();
        state.task_bus = std::sync::Arc::new(tokio::sync::RwLock::new(as_dyn));
        publish_backup_wake(&state, "outbox_test_1").await;
        let events = mem.drain(10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, BACKUP_WAKE_TYPE);
        assert_eq!(events[0].data["outbox_id"], "outbox_test_1");
        assert!(!events[0].data.to_string().contains("BEGIN RSA"));
    }

    /// Chaos: publish failure still wakes the in-process actor via notify.
    #[tokio::test]
    async fn publish_wake_notifies_even_when_bus_is_down() {
        use async_trait::async_trait;
        use opensesame_task_bus::{BusEvent, TaskBus};
        use std::sync::Arc;
        use tokio::sync::RwLock;

        let _guard = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_TASKBUS", "memory");

        struct DownBus;
        #[async_trait]
        impl TaskBus for DownBus {
            async fn publish(&self, _event: BusEvent) -> anyhow::Result<()> {
                anyhow::bail!("nats down");
            }
            async fn drain(&self, _max: usize) -> anyhow::Result<Vec<BusEvent>> {
                Ok(vec![])
            }
        }

        let mut state = crate::app_state::build(crate::config::Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        state.task_bus = Arc::new(RwLock::new(Arc::new(DownBus) as Arc<dyn TaskBus>));

        let notified = tokio::spawn({
            let n = state.backup_notify.clone();
            async move {
                tokio::time::timeout(std::time::Duration::from_secs(2), n.notified())
                    .await
                    .expect("backup_notify must fire despite bus failure")
            }
        });
        // Yield so the waiter is armed.
        tokio::task::yield_now().await;
        publish_backup_wake(&state, "outbox_down").await;
        notified.await.unwrap();
    }
}
