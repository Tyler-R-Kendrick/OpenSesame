//! Unit tests for the crate root (memory bus, subjects, backend selection).

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
