//! Real-server suites against the pinned nats-server (`#[ignore]`; run with
//! `OPENSESAME_MTLS_FIXTURES=1`): client mTLS admission, downgrade refusal,
//! the role matrix, system-subject denial, and identity rotation.

use super::live_harness::{secure_server, Pki, Roles};
use super::*;
use crate::nats_transport::NatsTransportSpec;
use opensesame_domain::transport::TransportError;
use serde_json::json;
use std::time::Duration;

fn config(url: &str, spec: NatsTransportSpec, role: NatsRole, provision: bool) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        nats_url: url.to_owned(),
        transport: spec,
        role,
        provision,
        fetch_expires: Duration::from_millis(500),
        ..NatsJetStreamConfig::default()
    }
}

fn backup_config(url: &str, spec: NatsTransportSpec, provision: bool) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        consumer_name: crate::BACKUP_CONSUMER_NAME.into(),
        filter_subject: Some(format!("{}.>", crate::SYSTEM_SUBJECT_PREFIX)),
        ..config(url, spec, NatsRole::Backup, provision)
    }
}

fn event(id: &str, ty: &str) -> BusEvent {
    BusEvent::cloud_event(id, "opensesame/live-test", ty, "2026-09-22T00:00:00Z", json!({"ok": true}))
}

fn is_tls_failure(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}").to_ascii_lowercase();
    text.contains("tls") || text.contains("certificate") || text.contains("handshake") || text.contains("alert")
}

/// AT-NATS-NOCERT: no client certificate → refused in the TLS handshake,
/// before any NATS authentication happens.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn no_client_certificate_is_refused_by_tls() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let spec = pki.client_spec(None, Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Host, false))
        .await
        .err()
        .expect("must not connect without a client certificate");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(is_tls_failure(&error), "expected a TLS failure, got {text}");
    assert!(!text.contains("authorization violation"), "refused at TLS, not at auth: {text}");
}

/// AT-NATS-NOCERT (untrusted): a certificate from another CA → TLS refusal.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn untrusted_client_certificate_is_refused_by_tls() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let stranger = pki.other_ca.issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName("stranger".into()));
    let spec = pki.client_spec(Some(&stranger), Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Host, false))
        .await
        .err()
        .expect("must not connect with an untrusted certificate");
    assert!(is_tls_failure(&error), "{error:#}");
}

/// AT-NATS-DOWNGRADE: a plaintext broker and a wrong-identity broker are
/// both refused by the secure profile; the bus is unavailable, never
/// memory, never plaintext.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn plaintext_or_wrong_identity_server_is_refused() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let leaf = pki.client("host.nats.opensesame.test");

    // 1. A plaintext broker (the local-dev profile) on the same host name.
    let plain_port = super::live_harness::free_port();
    let plain = super::live_harness::Server::start_with_args(
        "local-dev.conf",
        &[("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{plain_port}"))],
        &["-a".into(), "127.0.0.1".into(), "-p".into(), plain_port.to_string()],
    );
    let spec = pki.client_spec(Some(&leaf), Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&plain.url(), spec.clone(), NatsRole::Host, false))
        .await
        .err()
        .expect("secure profile must refuse a plaintext broker");
    assert!(is_tls_failure(&error) || format!("{error:#}").to_ascii_lowercase().contains("io"), "{error:#}");
    drop(plain);

    // 2. A TLS broker whose certificate comes from an unrelated CA.
    let wrong = {
        let other = pki.other_ca.issue_server(super::live_harness::SERVER_NAME);
        let (cert, key) = pki.write_leaf("wrong-server", &other);
        let port = super::live_harness::free_port();
        let mut env = roles.env(&pki, port);
        env.retain(|(k, _)| *k != "OPENSESAME_NATS_TLS_SERVER_CERT" && *k != "OPENSESAME_NATS_TLS_SERVER_KEY");
        env.push(("OPENSESAME_NATS_TLS_SERVER_CERT", cert.display().to_string()));
        env.push(("OPENSESAME_NATS_TLS_SERVER_KEY", key.display().to_string()));
        super::live_harness::Server::start("secure-client.conf", &env)
    };
    let error = NatsJetStreamTaskBus::connect(config(&wrong.url(), spec.clone(), NatsRole::Host, false))
        .await
        .err()
        .expect("secure profile must refuse a broker with a wrong certificate");
    assert!(is_tls_failure(&error), "{error:#}");

    // 3. A `nats://` URL beside the secure profile is a downgrade, refused
    //    before any connection is attempted.
    let error = NatsJetStreamTaskBus::connect(config(&format!("nats://localhost:{}", wrong.port), spec, NatsRole::Host, false))
        .await
        .err()
        .expect("nats:// with a secure profile is still TLS-required");
    assert!(is_tls_failure(&error) || error.downcast_ref::<TransportError>().is_some(), "{error:#}");
}

/// AT-TLS-VALID for NATS + AT-NATS-ROLES: the provisioner creates; the
/// host publishes and drains; the publisher cannot create or drain; the
/// consumer cannot publish; the backup sees only system wakes.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn role_matrix_on_a_real_server() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let leaf = pki.client("workload.nats.opensesame.test");
    let url = server.url();

    // Before provisioning, a runtime role fails closed with not_provisioned.
    let host_spec = pki.client_spec(Some(&leaf), Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&url, host_spec.clone(), NatsRole::Host, false))
        .await
        .err()
        .expect("unprovisioned");
    assert!(error.to_string().contains("not_provisioned"), "{error:#}");

    // A runtime identity cannot provision even when asked to.
    let error = NatsJetStreamTaskBus::connect(config(&url, host_spec.clone(), NatsRole::Host, true))
        .await
        .err()
        .expect("host identity holds no STREAM.CREATE");
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");

    // The provisioner creates the stream and both durable consumers.
    let prov_spec = pki.client_spec(Some(&leaf), Some(&roles.provisioner.0), false);
    let provisioner = NatsJetStreamTaskBus::connect(config(&url, prov_spec.clone(), NatsRole::Provisioner, true))
        .await
        .expect("provisioner creates stream + worker consumer");
    let _backup_prov = NatsJetStreamTaskBus::connect(backup_config(&url, prov_spec, true))
        .await
        .expect("provisioner creates backup consumer");
    drop(provisioner);

    // Host: publish + drain.
    let host = NatsJetStreamTaskBus::connect(config(&url, host_spec, NatsRole::Host, false))
        .await
        .expect("host connects after provisioning");
    assert!(host.health().connected());
    host.publish(event("h1", "principal.created")).await.expect("host publishes");
    host.publish(event("h2", "system.backup.wake")).await.expect("host publishes system wakes");
    let drained = host.drain(10).await.expect("host drains");
    assert!(drained.iter().any(|e| e.id == "h1"), "{drained:?}");

    // Publisher: user events yes, system subjects no (AT-NATS-SYSTEM),
    // no consumer, no provisioning.
    let pub_spec = pki.client_spec(Some(&leaf), Some(&roles.publisher.0), false);
    let publisher = NatsJetStreamTaskBus::connect(config(&url, pub_spec.clone(), NatsRole::Publisher, false))
        .await
        .expect("publisher connects without touching $JS.API");
    publisher.publish(event("p1", "principal.created")).await.expect("publisher publishes user events");
    let error = publisher.publish(event("p2", "system.backup.wake")).await.err().expect("system subject denied");
    assert!(!error.to_string().is_empty());
    assert!(publisher.drain(1).await.is_err(), "publisher has no consumer");
    let error = NatsJetStreamTaskBus::connect(config(&url, pub_spec, NatsRole::Provisioner, true))
        .await
        .err()
        .expect("publisher identity cannot create streams");
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");

    // Consumer: drains its own consumer, cannot publish.
    let cons_spec = pki.client_spec(Some(&leaf), Some(&roles.consumer.0), false);
    let consumer = NatsJetStreamTaskBus::connect(config(&url, cons_spec, NatsRole::Consumer, false))
        .await
        .expect("consumer connects");
    let drained = consumer.drain(10).await.expect("consumer drains");
    assert!(drained.iter().any(|e| e.id == "p1"), "{drained:?}");
    assert!(consumer.publish(event("c1", "principal.created")).await.is_err(), "consumer role does not publish");

    // Backup: only system wakes, on its own consumer; the worker consumer
    // is not reachable with the backup identity.
    let backup_spec = pki.client_spec(Some(&leaf), Some(&roles.backup.0), false);
    let backup = NatsJetStreamTaskBus::connect(backup_config(&url, backup_spec.clone(), false))
        .await
        .expect("backup connects");
    let wakes = backup.drain(10).await.expect("backup drains");
    assert!(wakes.iter().all(|e| e.r#type.starts_with("system.")), "{wakes:?}");
    assert!(wakes.iter().any(|e| e.id == "h2"), "{wakes:?}");
    let error = NatsJetStreamTaskBus::connect(config(&url, backup_spec, NatsRole::Consumer, false))
        .await
        .err()
        .expect("backup identity cannot open the worker consumer");
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");

    // AT-NATS-SYSTEM (callout side): the callout identity can neither
    // publish events nor open a consumer — its account has no stream.
    let callout_spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), false);
    let callout = NatsJetStreamTaskBus::connect(config(&url, callout_spec, NatsRole::Publisher, false))
        .await
        .expect("callout identity connects (AUTH account)");
    assert!(callout.publish(event("x1", "system.backup.wake")).await.is_err());
    assert!(callout.publish(event("x2", "principal.created")).await.is_err());
    // …and the events it tried never reached the stream.
    let after = host.drain(10).await.expect("drain");
    assert!(!after.iter().any(|e| e.id == "x1" || e.id == "x2" || e.id == "p2"), "{after:?}");
}

/// NAT-LIFECYCLE: rotate the client identity; the durable consumer keeps
/// its name and its sequence, and the old connection is drained.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn identity_rotation_keeps_the_durable_consumer() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let url = server.url();
    let first = pki.client("gen1.nats.opensesame.test");
    let second = pki.client("gen2.nats.opensesame.test");

    let prov = NatsJetStreamTaskBus::connect(config(&url, pki.client_spec(Some(&first), Some(&roles.provisioner.0), false), NatsRole::Provisioner, true))
        .await
        .expect("provision");
    drop(prov);
    let host = NatsJetStreamTaskBus::connect(config(&url, pki.client_spec(Some(&first), Some(&roles.host.0), false), NatsRole::Host, false))
        .await
        .expect("host");
    host.publish(event("r1", "principal.created")).await.expect("publish");
    let before = host.consumer_info().await.expect("info");
    assert_eq!(before.name, crate::DEFAULT_CONSUMER_NAME);
    let old_server_id = host.server_id().await;

    host.rotate(pki.client_spec(Some(&second), Some(&roles.host.0), false), None)
        .await
        .expect("rotate to the second identity");
    assert_eq!(host.server_id().await, old_server_id);
    host.publish(event("r2", "principal.created")).await.expect("publish after rotation");
    let drained = host.drain(10).await.expect("drain after rotation");
    assert!(drained.iter().any(|e| e.id == "r1") && drained.iter().any(|e| e.id == "r2"), "{drained:?}");
    let after = host.consumer_info().await.expect("info after");
    assert_eq!(after.name, before.name);
    assert!(after.delivered.stream_sequence >= before.delivered.stream_sequence + 1, "{after:?}");
    assert_eq!(after.config.durable_name.as_deref(), Some(crate::DEFAULT_CONSUMER_NAME));

    // A rotation to an untrusted identity fails and leaves the old session.
    let stranger = pki.other_ca.issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName("stranger".into()));
    assert!(host.rotate(pki.client_spec(Some(&stranger), Some(&roles.host.0), false), None).await.is_err());
    host.publish(event("r3", "principal.created")).await.expect("old session still serves");
}
