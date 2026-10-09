//! `TaskBus` configuration: URL guards, redaction, env precedence, and the
//! rule that the public (stored and returned) transport view carries no
//! locator — no path, no seed, no token (ADR 0132 §8).

use super::*;
use opensesame_task_bus::{NatsTransportPublic, NatsTransportView};

#[test]
fn rejects_http_nats_urls() {
    assert!(validate_nats_url("http://127.0.0.1:4222").is_err());
    assert!(validate_nats_url("nats://127.0.0.1:4222").is_ok());
    assert!(validate_nats_url("tls://box.tailnet.ts.net:4222").is_ok());
    assert!(validate_nats_url("nats://user:secret@127.0.0.1:4222").is_err());
}

#[test]
fn redacts_userinfo_from_nats_urls() {
    assert_eq!(
        redact_nats_url("nats://user:s3cret@127.0.0.1:4222"),
        "nats://***@127.0.0.1:4222"
    );
    assert_eq!(
        redact_nats_url("nats://127.0.0.1:4222"),
        "nats://127.0.0.1:4222"
    );
}

/// The one-time provisioning action refuses to run on the memory backend or
/// without a URL: it must never be a quiet no-op that looks provisioned.
#[tokio::test]
async fn provisioning_requires_the_nats_backend_and_a_url() {
    let resolved = ResolvedTaskBus {
        backend: TaskBusBackend::Memory,
        nats_url: None,
        source: TaskBusSource::Default,
        transport: NatsTransportSpec::plaintext(),
    };
    assert!(provision(&resolved).await.is_err());
}

/// A secure profile that cannot connect becomes `UnavailableTaskBus` —
/// never memory, never plaintext (AT-NATS-DOWNGRADE at the boot seam).
#[tokio::test]
async fn secure_profile_that_cannot_connect_is_unavailable_not_memory() {
    let public: NatsTransportPublic = serde_json::from_value(serde_json::json!({
        "transport": {
            "require_tls": true,
            "server_trust": {"name": "nats-ca", "kind": "private_root"},
            "client_identity": {"name": "nats-client", "kind": "pem_files"},
            "server_name": {"dns": "nats.invalid.example"}
        },
        "auth": {"kind": "none"}
    }))
    .unwrap();
    let resolved = ResolvedTaskBus {
        backend: TaskBusBackend::Nats,
        nats_url: Some("tls://nats.invalid.example:4222".into()),
        source: TaskBusSource::Stored,
        transport: NatsTransportSpec::from_public(public, NatsTransportSource::Stored),
    };
    assert!(resolved.is_secure());
    let bus = build_bus_or_unavailable(&resolved).await;
    let event = opensesame_task_bus::BusEvent::cloud_event(
        "1",
        "opensesame/gateway",
        "principal.created",
        "2026-09-22T00:00:00Z",
        serde_json::json!({}),
    );
    let error = bus
        .publish(event)
        .await
        .expect_err("must not accept events");
    assert!(
        error.to_string().starts_with("taskbus_unavailable:"),
        "{error}"
    );
    assert!(bus.drain(1).await.is_err(), "and must not drain either");
}

/// A *plaintext* loopback profile keeps its legacy in-memory fallback so an
/// unconfigured dev box still boots (the supported non-mTLS profile stays).
#[tokio::test]
async fn plaintext_profile_keeps_the_legacy_memory_fallback() {
    let resolved = ResolvedTaskBus {
        backend: TaskBusBackend::Nats,
        nats_url: Some("nats://127.0.0.1:1".into()),
        source: TaskBusSource::Stored,
        transport: NatsTransportSpec::plaintext(),
    };
    assert!(!resolved.is_secure());
    let bus = build_bus_or_unavailable(&resolved).await;
    let event = opensesame_task_bus::BusEvent::cloud_event(
        "1",
        "opensesame/gateway",
        "principal.created",
        "2026-09-22T00:00:00Z",
        serde_json::json!({}),
    );
    assert!(bus.publish(event).await.is_ok());
}

/// AT-NATS-CONFIG: what is stored, and what an operator GET returns, is a
/// reference set. Serialize a fully configured secure profile and assert no
/// path, seed, credential or key appears anywhere in the JSON.
#[tokio::test]
async fn stored_and_returned_transport_carry_no_locator() {
    let _guard = crate::app_state::test_env::lock();
    let vars = [
        ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "pem"),
        (
            "OPENSESAME_NATS_TLS_CERT_FILE",
            "/run/secrets/nats-client.crt",
        ),
        (
            "OPENSESAME_NATS_TLS_KEY_FILE",
            "/run/secrets/nats-client.key",
        ),
        ("OPENSESAME_NATS_TLS_TRUST_FILE", "/run/secrets/nats-ca.pem"),
        ("OPENSESAME_NATS_TLS_TRUST_KIND", "private_root"),
        ("OPENSESAME_NATS_TLS_SERVER_NAME", "nats.internal.example"),
        ("OPENSESAME_NATS_AUTH", "nkey"),
        ("OPENSESAME_NATS_NKEY_SEED_FILE", "/run/secrets/nats.seed"),
    ];
    for (k, v) in vars {
        std::env::set_var(k, v);
    }
    let db = opensesame_storage::Db::connect_memory().await.unwrap();
    let resolved = resolve(&db).await.unwrap();
    for (k, _) in vars {
        std::env::remove_var(k);
    }

    let public = resolved.transport.public();
    persist_transport(&db, &public).await.unwrap();
    let stored = db.get_host_kv(KV_TRANSPORT).await.unwrap().unwrap();
    let view: NatsTransportView =
        serde_json::from_str(&serde_json::to_string(&resolved.transport.view()).unwrap()).unwrap();
    let rendered = format!(
        "{stored}{}{:?}",
        serde_json::to_string(&view).unwrap(),
        resolved.transport
    );
    for forbidden in [
        "/run/secrets",
        "nats-client.crt",
        "nats-client.key",
        "nats-ca.pem",
        "nats.seed",
        "SUA",
        "BEGIN",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "public transport leaked {forbidden}: {rendered}"
        );
    }
    // …and it still says what the policy IS.
    assert!(view.require_tls);
    assert_eq!(view.auth, "nkey");
    assert!(view.discovery_ignored);
    assert!(stored.contains("private_root"));
}

#[tokio::test]
async fn env_overrides_stored_backend() {
    let _guard = crate::app_state::test_env::lock();
    let prev_taskbus = std::env::var_os("OPENSESAME_TASKBUS");
    let prev_nats = std::env::var_os("NATS_URL");
    std::env::remove_var("OPENSESAME_TASKBUS");
    std::env::remove_var("NATS_URL");

    let db = opensesame_storage::Db::connect_memory().await.unwrap();
    persist(
        &db,
        TaskBusBackend::Nats,
        Some("nats://stored.example:4222"),
    )
    .await
    .unwrap();

    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let resolved = resolve(&db).await.unwrap();
    assert!(matches!(resolved.source, TaskBusSource::Env));
    assert!(matches!(resolved.backend, TaskBusBackend::Memory));
    assert!(!resolved.is_secure());

    match prev_taskbus {
        Some(v) => std::env::set_var("OPENSESAME_TASKBUS", v),
        None => std::env::remove_var("OPENSESAME_TASKBUS"),
    }
    match prev_nats {
        Some(v) => std::env::set_var("NATS_URL", v),
        None => std::env::remove_var("NATS_URL"),
    }
}

/// An invalid persisted transport policy is an error, never a silent
/// permissive default ("Configuration is authority").
#[tokio::test]
async fn invalid_stored_transport_refuses_to_resolve() {
    let _guard = crate::app_state::test_env::lock();
    std::env::remove_var("OPENSESAME_TASKBUS");
    std::env::remove_var("NATS_URL");
    let db = opensesame_storage::Db::connect_memory().await.unwrap();
    db.set_host_kv(KV_TRANSPORT, "{\"transport\":{\"cert_file\":\"/x\"}}")
        .await
        .unwrap();
    assert!(resolve(&db).await.is_err());
}

/// AT-NATS-FACTORIES: every NATS consumer in this binary goes through the
/// resolved transport. No file may call a bare factory that skips it.
#[test]
fn no_gateway_call_site_bypasses_the_resolved_transport() {
    for (name, src) in [
        ("taskbus_config.rs", include_str!("taskbus_config.rs")),
        ("backup_bus.rs", include_str!("backup_bus.rs")),
        (
            "routes/taskbus_config.rs",
            include_str!("routes/taskbus_config.rs"),
        ),
    ] {
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !production.contains("async_nats::connect"),
            "{name} dials NATS directly"
        );
        assert!(
            !production.contains("create_from_env"),
            "{name} uses the env-only factory instead of the resolved transport"
        );
        assert!(
            !production.contains("create_nats("),
            "{name} uses the transport-less factory"
        );
    }
    // The only NatsJetStreamConfig literals are the ones that carry a
    // transport: the backup consumer builds its config in the crate.
    let backup = include_str!("backup_bus.rs");
    let production = backup.split("#[cfg(test)]").next().unwrap_or(backup);
    assert!(production.contains("backup_consumer_config"));
    assert!(!production.contains("NatsJetStreamConfig {"));
}
