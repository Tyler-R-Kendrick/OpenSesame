//! AT-NATS-ROLES / AT-NATS-SYSTEM on the pinned server: the least-privilege
//! identity matrix of `ops/nats/secure-client.conf`.
//!
//! One nkey per role, each with its own subject and `$JS.API` permissions.
//! Provisioning is a separate identity and a separate action: a runtime role
//! that finds no durable fails `not_provisioned` and never creates one, and a
//! runtime identity asked to provision is refused by the server.

use super::live_harness::{secure_server, Pki, Roles};
use super::live_tests::{backup_config, config, event, must_fail};
use super::*;
use opensesame_domain::transport::PeerIdentitySelector;

/// The one-time provisioning action: stream + both durable consumers.
async fn provision(pki: &Pki, roles: &Roles, url: &str, leaf: &IssuedLeafRef<'_>) {
    let spec = pki.client_spec(Some(leaf.0), Some(&roles.provisioner.0), false);
    let provisioner =
        NatsJetStreamTaskBus::connect(config(url, spec.clone(), NatsRole::Provisioner, true))
            .await
            .expect("provisioner creates stream + worker consumer");
    NatsJetStreamTaskBus::connect(backup_config(url, spec, true))
        .await
        .expect("provisioner creates backup consumer");
    drop(provisioner);
}

/// Newtype so the helpers read as `leaf` without repeating the long type.
struct IssuedLeafRef<'a>(&'a opensesame_transport_security::testkit::IssuedLeaf);

/// A runtime role finds nothing before provisioning, and cannot provision.
async fn refuses_before_provisioning(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    leaf: &IssuedLeafRef<'_>,
) {
    let spec = pki.client_spec(Some(leaf.0), Some(&roles.host.0), false);
    let error = must_fail(
        NatsJetStreamTaskBus::connect(config(url, spec.clone(), NatsRole::Host, false)).await,
        "unprovisioned",
    );
    assert!(error.to_string().contains("not_provisioned"), "{error:#}");

    let error = must_fail(
        NatsJetStreamTaskBus::connect(config(url, spec, NatsRole::Host, true)).await,
        "host identity holds no STREAM.CREATE",
    );
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");
}

/// Host: publishes user and system events, drains the worker consumer.
async fn host_publishes_and_drains(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    leaf: &IssuedLeafRef<'_>,
) -> NatsJetStreamTaskBus {
    let spec = pki.client_spec(Some(leaf.0), Some(&roles.host.0), false);
    let host = NatsJetStreamTaskBus::connect(config(url, spec, NatsRole::Host, false))
        .await
        .expect("host connects after provisioning");
    host.publish(event("h1", "principal.created"))
        .await
        .expect("host publishes");
    host.publish(event("h2", "system.backup.wake"))
        .await
        .expect("host publishes system wakes");
    let drained = host.drain(10).await.expect("host drains");
    assert!(drained.iter().any(|e| e.id == "h1"), "{drained:?}");
    host
}

/// Publisher: user events only. AT-NATS-SYSTEM — `system.>` is denied by
/// subject policy, not by anything the publisher chooses to send.
async fn publisher_cannot_reach_system_or_provision(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    leaf: &IssuedLeafRef<'_>,
) {
    let spec = pki.client_spec(Some(leaf.0), Some(&roles.publisher.0), false);
    let publisher =
        NatsJetStreamTaskBus::connect(config(url, spec.clone(), NatsRole::Publisher, false))
            .await
            .expect("publisher connects without touching $JS.API");
    publisher
        .publish(event("p1", "principal.created"))
        .await
        .expect("publisher publishes user events");
    let error = publisher
        .publish(event("p2", "system.backup.wake"))
        .await
        .expect_err("system subject denied");
    assert!(!error.to_string().is_empty());
    assert!(
        publisher.drain(1).await.is_err(),
        "publisher has no consumer"
    );
    let error = must_fail(
        NatsJetStreamTaskBus::connect(config(url, spec, NatsRole::Provisioner, true)).await,
        "publisher identity cannot create streams",
    );
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");
}

/// Consumer drains only; backup sees only system wakes and cannot open the
/// worker consumer (one durable per tenant worker, never shared by accident).
async fn consumer_and_backup_are_separate(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    leaf: &IssuedLeafRef<'_>,
) {
    let cons = pki.client_spec(Some(leaf.0), Some(&roles.consumer.0), false);
    let consumer = NatsJetStreamTaskBus::connect(config(url, cons, NatsRole::Consumer, false))
        .await
        .expect("consumer connects");
    let drained = consumer.drain(10).await.expect("consumer drains");
    assert!(drained.iter().any(|e| e.id == "p1"), "{drained:?}");
    assert!(
        consumer
            .publish(event("c1", "principal.created"))
            .await
            .is_err(),
        "consumer role does not publish"
    );

    let backup_spec = pki.client_spec(Some(leaf.0), Some(&roles.backup.0), false);
    let backup = NatsJetStreamTaskBus::connect(backup_config(url, backup_spec.clone(), false))
        .await
        .expect("backup connects");
    let wakes = backup.drain(10).await.expect("backup drains");
    assert!(
        wakes.iter().all(|e| e.r#type.starts_with("system.")),
        "{wakes:?}"
    );
    assert!(wakes.iter().any(|e| e.id == "h2"), "{wakes:?}");
    let error = must_fail(
        NatsJetStreamTaskBus::connect(config(url, backup_spec, NatsRole::Consumer, false)).await,
        "backup identity cannot open the worker consumer",
    );
    assert!(!error.to_string().contains("not_provisioned"), "{error:#}");
}

/// AT-NATS-SYSTEM (callout side): the callout identity lives in the AUTH
/// account. It can publish no event at all, and nothing it tried appears.
async fn callout_identity_publishes_nothing(
    pki: &Pki,
    roles: &Roles,
    url: &str,
    leaf: &IssuedLeafRef<'_>,
    host: &NatsJetStreamTaskBus,
) {
    let spec = pki.client_spec(Some(leaf.0), Some(&roles.callout.0), false);
    let callout = NatsJetStreamTaskBus::connect(config(url, spec, NatsRole::Publisher, false))
        .await
        .expect("callout identity connects (AUTH account)");
    assert!(callout
        .publish(event("x1", "system.backup.wake"))
        .await
        .is_err());
    assert!(callout
        .publish(event("x2", "principal.created"))
        .await
        .is_err());
    let after = host.drain(10).await.expect("drain");
    assert!(
        !after
            .iter()
            .any(|e| e.id == "x1" || e.id == "x2" || e.id == "p2"),
        "{after:?}"
    );
}

/// AT-NATS-ROLES: the whole matrix, in order, on one real server.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn role_matrix_on_a_real_server() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let issued = pki.client("workload.nats.opensesame.test");
    let leaf = IssuedLeafRef(&issued);
    let url = server.url();

    refuses_before_provisioning(&pki, &roles, &url, &leaf).await;
    Box::pin(provision(&pki, &roles, &url, &leaf)).await;
    let host = host_publishes_and_drains(&pki, &roles, &url, &leaf).await;
    assert!(host.health().connected());
    Box::pin(publisher_cannot_reach_system_or_provision(
        &pki, &roles, &url, &leaf,
    ))
    .await;
    Box::pin(consumer_and_backup_are_separate(&pki, &roles, &url, &leaf)).await;
    callout_identity_publishes_nothing(&pki, &roles, &url, &leaf, &host).await;
    let _ = PeerIdentitySelector::DnsName("unused".into());
}
