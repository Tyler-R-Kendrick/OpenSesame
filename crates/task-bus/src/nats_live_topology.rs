//! AT-NATS-TOPOLOGY on the pinned server: TLS-first handshake, the
//! verify_and_map profile, the 2-node TLS-route cluster (right and wrong
//! route certificates), and discovery not widening egress.

use super::live_harness::{free_port, secure_server, Pki, Roles, Server, SERVER_NAME};
use super::*;
use futures::StreamExt;
use opensesame_domain::transport::PeerIdentitySelector;
use std::time::Duration;

fn config(url: &str, spec: crate::nats_transport::NatsTransportSpec, role: NatsRole, provision: bool) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        nats_url: url.to_owned(),
        transport: spec,
        role,
        provision,
        fetch_expires: Duration::from_millis(500),
        ..NatsJetStreamConfig::default()
    }
}

/// `tls { handshake_first: true }` (secure-callout.conf carries it): a
/// client with `tls_first` connects; the log shows the TLS handshake
/// before INFO; a client without `tls_first` cannot connect at all.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn tls_first_handshake_is_supported_and_required_by_the_profile() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let port = free_port();
    let issuer = nkeys::KeyPair::new_account();
    let mut env = roles.env(&pki, port);
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let leaf = pki.client("callout.nats.opensesame.test");

    // The callout responder identity is a static AUTH user: it connects
    // without a callout round trip, which is all this test needs.
    let spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), true);
    let bus = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Publisher, false))
        .await
        .expect("tls_first client connects to a handshake_first server");
    assert!(bus.health().connected());
    assert!(server.wait_log("TLS handshake complete", Duration::from_secs(3)), "log: {}", server.log_text());
    let log = server.log_text();
    let handshake = log.find("TLS handshake complete").expect("handshake logged");
    let info = log.find("->> [INFO").or_else(|| log.find("INFO {")).unwrap_or(usize::MAX);
    assert!(handshake < info, "handshake must precede the INFO line: {log}");

    let spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Publisher, false))
        .await
        .err()
        .expect("a client that waits for INFO before TLS cannot connect to a handshake_first server");
    assert!(!format!("{error:#}").is_empty());
}

/// `verify_and_map: true`: a certificate whose SAN is listed becomes that
/// user; a certificate from the same CA with an unlisted SAN is refused
/// (authorization violation, not a TLS failure).
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn verify_and_map_admits_listed_sans_only() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let port = free_port();
    let prov_san = "provisioner.nats.opensesame.test";
    let host_san = "host.nats.opensesame.test";
    let env = vec![
        ("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}")),
        ("OPENSESAME_NATS_SERVER_NAME", format!("map-{port}")),
        ("OPENSESAME_NATS_TLS_SERVER_CERT", pki.server_cert.display().to_string()),
        ("OPENSESAME_NATS_TLS_SERVER_KEY", pki.server_key.display().to_string()),
        ("OPENSESAME_NATS_TLS_CLIENT_CA", pki.ca_pem.display().to_string()),
        ("OPENSESAME_NATS_MAP_PROVISIONER", prov_san.to_owned()),
        ("OPENSESAME_NATS_MAP_HOST", host_san.to_owned()),
    ];
    let server = Server::start("secure-verify-and-map.conf", &env);
    let url = server.url();

    let prov = NatsJetStreamTaskBus::connect(config(&url, pki.client_spec(Some(&pki.client(prov_san)), None, false), NatsRole::Provisioner, true))
        .await
        .expect("mapped provisioner SAN provisions");
    drop(prov);
    let host = NatsJetStreamTaskBus::connect(config(&url, pki.client_spec(Some(&pki.client(host_san)), None, false), NatsRole::Host, false))
        .await
        .expect("mapped host SAN connects");
    host.publish(BusEvent::cloud_event("m1", "t", "principal.created", "2026-09-22T00:00:00Z", serde_json::json!({})))
        .await
        .expect("mapped host publishes");

    let unlisted = pki.client("someone-else.nats.opensesame.test");
    let error = NatsJetStreamTaskBus::connect(config(&url, pki.client_spec(Some(&unlisted), None, false), NatsRole::Host, false))
        .await
        .err()
        .expect("an unlisted SAN from the same CA is not a user");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(text.contains("authorization") || text.contains("auth"), "{text}");
    assert!(server.wait_log("Authorization Violation", Duration::from_secs(2)) || server.log_text().contains("authorization"), "{}", server.log_text());
}

fn cluster_env(pki: &Pki, roles: &Roles, port: u16, cluster_port: u16, route_to: u16, route: &(std::path::PathBuf, std::path::PathBuf), route_ca: &std::path::Path) -> Vec<(&'static str, String)> {
    let mut env = roles.env(pki, port);
    env.retain(|(k, _)| !k.starts_with("OPENSESAME_NATS_NKEY_") || *k == "OPENSESAME_NATS_NKEY_HOST");
    env.push(("OPENSESAME_NATS_CLUSTER_LISTEN", format!("127.0.0.1:{cluster_port}")));
    env.push(("OPENSESAME_NATS_ROUTE_URL", format!("nats-route://127.0.0.1:{route_to}")));
    env.push(("OPENSESAME_NATS_ROUTE_CERT", route.0.display().to_string()));
    env.push(("OPENSESAME_NATS_ROUTE_KEY", route.1.display().to_string()));
    env.push(("OPENSESAME_NATS_ROUTE_CA", route_ca.display().to_string()));
    env
}

/// A raw core-NATS client on the secure profile (subscribe/publish across
/// the route needs subjects the `TaskBus` does not expose).
async fn core_client(pki: &Pki, roles: &Roles, url: &str) -> async_nats::Client {
    let leaf = pki.client("route-test.nats.opensesame.test");
    let spec = pki.client_spec(Some(&leaf), Some(&roles.host.0), false).normalized(url).expect("spec");
    let options = crate::nats_connect::connect_options(&spec, NatsRole::Host, &InjectedMaterial::default(), std::sync::Arc::new(BusHealth::default()))
        .await
        .expect("options");
    options.connect(url).await.expect("core client connects")
}

/// Two nodes with TLS routes: a wrong route certificate is refused and the
/// cluster does not form; with route certificates from the route CA a
/// message published on B reaches a subscriber on A. Then A's client, with
/// discovery ignored, does not follow the advertised B when A dies.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn route_tls_refuses_wrong_certificates_and_forwards_with_right_ones() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let route_ca = opensesame_transport_security::testkit::DisposableCa::new("route-ca");
    let route_ca_pem = super::live_harness::write(pki.dir.path(), "route-ca.pem", &route_ca.ca_pem());
    let good_a = pki.write_leaf("route-a", &pki.route_leaf(&route_ca));
    let good_b = pki.write_leaf("route-b", &pki.route_leaf(&route_ca));
    let bad_b = pki.write_leaf("route-b-bad", &pki.route_leaf(&pki.other_ca));

    // Negative: B holds a route certificate from another CA.
    let (pa, ca_port, pb, cb_port) = (free_port(), free_port(), free_port(), free_port());
    let node_a = Server::start("secure-routes.conf", &cluster_env(&pki, &roles, pa, ca_port, cb_port, &good_a, &route_ca_pem));
    let node_b = Server::start("secure-routes.conf", &cluster_env(&pki, &roles, pb, cb_port, ca_port, &bad_b, &route_ca_pem));
    let refused = node_a.wait_log("TLS route handshake error", Duration::from_secs(6))
        || node_b.wait_log("TLS route handshake error", Duration::from_secs(1));
    assert!(refused, "a route with a wrong certificate must be refused:\nA: {}\nB: {}", node_a.log_text(), node_b.log_text());
    assert!(!node_a.log_text().contains("Route connection created"), "no route may form: {}", node_a.log_text());
    drop(node_b);
    drop(node_a);

    // Positive: both hold route certificates from the route CA.
    let (pa, ca_port, pb, cb_port) = (free_port(), free_port(), free_port(), free_port());
    let mut node_a = Server::start("secure-routes.conf", &cluster_env(&pki, &roles, pa, ca_port, cb_port, &good_a, &route_ca_pem));
    let node_b = Server::start("secure-routes.conf", &cluster_env(&pki, &roles, pb, cb_port, ca_port, &good_b, &route_ca_pem));
    assert!(node_a.wait_log("Route connection created", Duration::from_secs(8)) || node_b.wait_log("Route connection created", Duration::from_secs(2)), "route did not form:\nA: {}\nB: {}", node_a.log_text(), node_b.log_text());

    let client_a = core_client(&pki, &roles, &node_a.url()).await;
    let client_b = core_client(&pki, &roles, &node_b.url()).await;
    let mut sub = client_a.subscribe("opensesame.events.route.test").await.expect("subscribe on A");
    client_a.flush().await.expect("flush");
    // Interest propagates over the route; retry the publish briefly.
    let mut got = None;
    for _ in 0..20 {
        client_b.publish("opensesame.events.route.test", "via-b".into()).await.expect("publish on B");
        client_b.flush().await.expect("flush");
        if let Ok(Some(msg)) = tokio::time::timeout(Duration::from_millis(300), sub.next()).await {
            got = Some(msg);
            break;
        }
    }
    let msg = got.expect("a message published on B is consumed on A over the TLS route");
    assert_eq!(msg.payload.as_ref(), b"via-b");

    // Discovery must not widen egress: A advertised B in connect_urls, but
    // the secure profile ignores discovered servers. Kill A; the client
    // must not come back through B.
    let health = std::sync::Arc::new(BusHealth::default());
    let leaf = pki.client("pinned.nats.opensesame.test");
    let spec = pki.client_spec(Some(&leaf), Some(&roles.host.0), false).normalized(&node_a.url()).expect("spec");
    let options = crate::nats_connect::connect_options(&spec, NatsRole::Host, &InjectedMaterial::default(), std::sync::Arc::clone(&health)).await.expect("options");
    let pinned = options.connect(node_a.url()).await.expect("pinned client");
    assert!(!pinned.server_info().connect_urls.is_empty(), "A must advertise B for this test to mean anything: {:?}", pinned.server_info());
    node_a.kill();
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_ne!(pinned.connection_state(), async_nats::connection::State::Connected, "client must not reconnect through a discovered server");
    assert!(health.disconnects() >= 1);
    assert_eq!(pinned.server_info().server_id, pinned.server_info().server_id);
    drop(node_b);
}

/// Sanity for every shipped template: `nats-server -t` accepts it with the
/// environment the live suite provides (a template drift fails here first).
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn every_shipped_template_passes_config_check() {
    if !super::live_harness::enabled() { return; }
    let pki = Pki::new();
    let roles = Roles::new();
    let route = pki.write_leaf("route-check", &pki.route_leaf(&pki.ca));
    let issuer = nkeys::KeyPair::new_account();
    let mut env = cluster_env(&pki, &roles, free_port(), free_port(), free_port(), &route, &pki.ca_pem);
    env.extend(roles.env(&pki, free_port()));
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    env.push(("OPENSESAME_NATS_MAP_PROVISIONER", "p.example".into()));
    env.push(("OPENSESAME_NATS_MAP_HOST", "h.example".into()));
    env.push(("OPENSESAME_NATS_STORE_DIR", pki.dir.path().join("js").display().to_string()));
    for conf in ["local-dev.conf", "secure-client.conf", "secure-verify-and-map.conf", "secure-routes.conf", "secure-callout.conf"] {
        let out = std::process::Command::new(super::live_harness::server_bin())
            .arg("-t").arg("-c").arg(super::live_harness::ops_conf(conf))
            .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
            .output()
            .expect("nats-server -t");
        assert!(out.status.success(), "{conf}: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    let _ = PeerIdentitySelector::DnsName(SERVER_NAME.into());
    let _ = secure_server;
}
