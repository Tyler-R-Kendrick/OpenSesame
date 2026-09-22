//! AT-NATS-TOPOLOGY, routes half: the 2-node cluster whose *route* listener
//! has its own TLS block. A route certificate from the wrong CA is refused
//! and the cluster does not form; with route certificates from the route CA
//! a message published on node B reaches a subscriber on node A. Discovery
//! (`INFO.connect_urls`) never widens the client's egress.

use super::live_harness::{free_port, Pki, Roles, Server};
use super::*;
use futures::StreamExt;
use std::time::Duration;

pub(crate) fn cluster_env(
    pki: &Pki,
    roles: &Roles,
    port: u16,
    cluster_port: u16,
    route_to: u16,
    route: &(std::path::PathBuf, std::path::PathBuf),
    route_ca: &std::path::Path,
) -> Vec<(&'static str, String)> {
    let mut env = roles.env(pki, port);
    env.retain(|(k, _)| {
        !k.starts_with("OPENSESAME_NATS_NKEY_") || *k == "OPENSESAME_NATS_NKEY_HOST"
    });
    env.push((
        "OPENSESAME_NATS_CLUSTER_LISTEN",
        format!("127.0.0.1:{cluster_port}"),
    ));
    env.push((
        "OPENSESAME_NATS_ROUTE_URL",
        format!("nats-route://127.0.0.1:{route_to}"),
    ));
    env.push(("OPENSESAME_NATS_ROUTE_CERT", route.0.display().to_string()));
    env.push(("OPENSESAME_NATS_ROUTE_KEY", route.1.display().to_string()));
    env.push(("OPENSESAME_NATS_ROUTE_CA", route_ca.display().to_string()));
    env
}

/// A raw core-NATS client on the secure profile (subscribe/publish across
/// the route needs subjects the `TaskBus` does not expose).
async fn core_client(pki: &Pki, roles: &Roles, url: &str) -> async_nats::Client {
    let leaf = pki.client("route-test.nats.opensesame.test");
    let spec = pki
        .client_spec(Some(&leaf), Some(&roles.host.0), false)
        .normalized(url)
        .expect("spec");
    let options = crate::nats_connect::connect_options(
        &spec,
        NatsRole::Host,
        &InjectedMaterial::default(),
        std::sync::Arc::new(BusHealth::default()),
    )
    .await
    .expect("options");
    options.connect(url).await.expect("core client connects")
}

/// Start one node of the 2-node cluster.
fn node(
    pki: &Pki,
    roles: &Roles,
    ports: (u16, u16, u16),
    route: &(std::path::PathBuf, std::path::PathBuf),
    route_ca: &std::path::Path,
) -> Server {
    let (client_port, route_port, peer_route_port) = ports;
    Server::start(
        "secure-routes.conf",
        &cluster_env(
            pki,
            roles,
            client_port,
            route_port,
            peer_route_port,
            route,
            route_ca,
        ),
    )
}

/// A route certificate from the wrong CA: the TLS route handshake fails and
/// no route is created. Route TLS is its own listener with its own trust —
/// client mTLS says nothing about it.
fn wrong_route_certificate_forms_no_cluster(
    pki: &Pki,
    roles: &Roles,
    good_a: &(std::path::PathBuf, std::path::PathBuf),
    bad_b: &(std::path::PathBuf, std::path::PathBuf),
    route_ca_pem: &std::path::Path,
) {
    let (ac, ar, bc, br) = (free_port(), free_port(), free_port(), free_port());
    let node_a = node(pki, roles, (ac, ar, br), good_a, route_ca_pem);
    let node_b = node(pki, roles, (bc, br, ar), bad_b, route_ca_pem);
    let refused = node_a.wait_log("TLS route handshake error", Duration::from_secs(6))
        || node_b.wait_log("TLS route handshake error", Duration::from_secs(1));
    assert!(
        refused,
        "a route with a wrong certificate must be refused:\nA: {}\nB: {}",
        node_a.log_text(),
        node_b.log_text()
    );
    assert!(
        !node_a.log_text().contains("Route connection created"),
        "no route may form: {}",
        node_a.log_text()
    );
}

/// With route certificates from the route CA the cluster forms and a message
/// published on B reaches a subscriber on A.
async fn message_crosses_the_tls_route(pki: &Pki, roles: &Roles, a: &Server, b: &Server) {
    let client_a = core_client(pki, roles, &a.url()).await;
    let client_b = core_client(pki, roles, &b.url()).await;
    let mut sub = client_a
        .subscribe("opensesame.events.route.test")
        .await
        .expect("subscribe on A");
    client_a.flush().await.expect("flush");
    // Interest propagates over the route; retry the publish briefly.
    let mut got = None;
    for _ in 0..20 {
        client_b
            .publish("opensesame.events.route.test", "via-b".into())
            .await
            .expect("publish on B");
        client_b.flush().await.expect("flush");
        if let Ok(Some(msg)) = tokio::time::timeout(Duration::from_millis(300), sub.next()).await {
            got = Some(msg);
            break;
        }
    }
    let msg = got.expect("a message published on B is consumed on A over the TLS route");
    assert_eq!(msg.payload.as_ref(), b"via-b");
}

/// AT-NATS-DOWNGRADE (discovery half): A advertises B in `connect_urls`, but
/// the secure profile sets `ignore_discovered_servers`. Kill A and the client
/// must not reappear on B — discovery never widens egress.
async fn discovery_does_not_widen_egress(pki: &Pki, roles: &Roles, node_a: &mut Server) {
    let health = std::sync::Arc::new(BusHealth::default());
    let leaf = pki.client("pinned.nats.opensesame.test");
    let spec = pki
        .client_spec(Some(&leaf), Some(&roles.host.0), false)
        .normalized(&node_a.url())
        .expect("spec");
    let options = crate::nats_connect::connect_options(
        &spec,
        NatsRole::Host,
        &InjectedMaterial::default(),
        std::sync::Arc::clone(&health),
    )
    .await
    .expect("options");
    let pinned = options.connect(node_a.url()).await.expect("pinned client");
    assert!(
        !pinned.server_info().connect_urls.is_empty(),
        "A must advertise B for this test to mean anything: {:?}",
        pinned.server_info()
    );
    node_a.kill();
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_ne!(
        pinned.connection_state(),
        async_nats::connection::State::Connected,
        "client must not reconnect through a discovered server"
    );
    assert!(health.disconnects() >= 1);
}

/// AT-NATS-TOPOLOGY (routes): wrong route certificate → no cluster; right
/// ones → a message crosses; and discovery still does not widen egress.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn route_tls_refuses_wrong_certificates_and_forwards_with_right_ones() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let route_ca = opensesame_transport_security::testkit::DisposableCa::new("route-ca");
    let route_ca_pem =
        super::live_harness::write(pki.dir.path(), "route-ca.pem", &route_ca.ca_pem());
    let good_a = pki.write_leaf("route-a", &Pki::route_leaf(&route_ca));
    let good_b = pki.write_leaf("route-b", &Pki::route_leaf(&route_ca));
    let bad_b = pki.write_leaf("route-b-bad", &Pki::route_leaf(&pki.other_ca));

    wrong_route_certificate_forms_no_cluster(&pki, &roles, &good_a, &bad_b, &route_ca_pem);

    let (ac, ar, bc, br) = (free_port(), free_port(), free_port(), free_port());
    let mut node_a = node(&pki, &roles, (ac, ar, br), &good_a, &route_ca_pem);
    let node_b = node(&pki, &roles, (bc, br, ar), &good_b, &route_ca_pem);
    assert!(
        node_a.wait_log("Route connection created", Duration::from_secs(8))
            || node_b.wait_log("Route connection created", Duration::from_secs(2)),
        "route did not form:\nA: {}\nB: {}",
        node_a.log_text(),
        node_b.log_text()
    );

    Box::pin(message_crosses_the_tls_route(
        &pki, &roles, &node_a, &node_b,
    ))
    .await;
    Box::pin(discovery_does_not_widen_egress(&pki, &roles, &mut node_a)).await;
    drop(node_b);
}
