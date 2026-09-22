//! AT-NATS-TOPOLOGY on the pinned server: TLS-first handshake, the
//! `verify_and_map` profile, the 2-node TLS-route cluster (right and wrong
//! route certificates), and discovery not widening egress.

use super::live_harness::{free_port, secure_server, Pki, Roles, Server, SERVER_NAME};
use super::live_routes::cluster_env;
use super::*;
use opensesame_domain::transport::PeerIdentitySelector;
use std::time::Duration;

pub(crate) fn config(
    url: &str,
    spec: crate::nats_transport::NatsTransportSpec,
    role: NatsRole,
    provision: bool,
) -> NatsJetStreamConfig {
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
    if !super::live_harness::enabled() {
        return;
    }
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
    let bus =
        NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Publisher, false))
            .await
            .expect("tls_first client connects to a handshake_first server");
    assert!(
        super::live_harness::wait_until(|| bus.health().connected(), Duration::from_secs(5)).await,
        "the tls_first client never reported Connected"
    );
    assert!(
        server.wait_log("TLS handshake complete", Duration::from_secs(3)),
        "log: {}",
        server.log_text()
    );
    let log = server.log_text();
    let handshake = log
        .find("TLS handshake complete")
        .expect("handshake logged");
    let info = log
        .find("->> [INFO")
        .or_else(|| log.find("INFO {"))
        .unwrap_or(usize::MAX);
    assert!(
        handshake < info,
        "handshake must precede the INFO line: {log}"
    );

    let spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), false);
    let error = NatsJetStreamTaskBus::connect(config(
        &server.url(),
        spec,
        NatsRole::Publisher,
        false,
    ))
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
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let port = free_port();
    let prov_san = "provisioner.nats.opensesame.test";
    let host_san = "host.nats.opensesame.test";
    let env = vec![
        ("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}")),
        ("OPENSESAME_NATS_SERVER_NAME", format!("map-{port}")),
        (
            "OPENSESAME_NATS_TLS_SERVER_CERT",
            pki.server_cert.display().to_string(),
        ),
        (
            "OPENSESAME_NATS_TLS_SERVER_KEY",
            pki.server_key.display().to_string(),
        ),
        (
            "OPENSESAME_NATS_TLS_CLIENT_CA",
            pki.ca_pem.display().to_string(),
        ),
        ("OPENSESAME_NATS_MAP_PROVISIONER", prov_san.to_owned()),
        ("OPENSESAME_NATS_MAP_HOST", host_san.to_owned()),
    ];
    let server = Server::start("secure-verify-and-map.conf", &env);
    let url = server.url();

    let prov = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&pki.client(prov_san)), None, false),
        NatsRole::Provisioner,
        true,
    ))
    .await
    .expect("mapped provisioner SAN provisions");
    drop(prov);
    let host = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&pki.client(host_san)), None, false),
        NatsRole::Host,
        false,
    ))
    .await
    .expect("mapped host SAN connects");
    host.publish(BusEvent::cloud_event(
        "m1",
        "t",
        "principal.created",
        "2026-09-22T00:00:00Z",
        serde_json::json!({}),
    ))
    .await
    .expect("mapped host publishes");

    let unlisted = pki.client("someone-else.nats.opensesame.test");
    let error = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&unlisted), None, false),
        NatsRole::Host,
        false,
    ))
    .await
    .err()
    .expect("an unlisted SAN from the same CA is not a user");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(
        text.contains("authorization") || text.contains("auth"),
        "{text}"
    );
    assert!(
        server.wait_log("Authorization Violation", Duration::from_secs(2))
            || server.log_text().contains("authorization"),
        "{}",
        server.log_text()
    );
}

/// Sanity for every shipped template: `nats-server -t` accepts it with the
/// environment the live suite provides (a template drift fails here first).
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn every_shipped_template_passes_config_check() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let route = pki.write_leaf("route-check", &Pki::route_leaf(&pki.ca));
    let issuer = nkeys::KeyPair::new_account();
    let mut env = cluster_env(
        &pki,
        &roles,
        free_port(),
        free_port(),
        free_port(),
        &route,
        &pki.ca_pem,
    );
    env.extend(roles.env(&pki, free_port()));
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    env.push(("OPENSESAME_NATS_MAP_PROVISIONER", "p.example".into()));
    env.push(("OPENSESAME_NATS_MAP_HOST", "h.example".into()));
    env.push((
        "OPENSESAME_NATS_STORE_DIR",
        pki.dir.path().join("js").display().to_string(),
    ));
    for conf in [
        "local-dev.conf",
        "secure-client.conf",
        "secure-verify-and-map.conf",
        "secure-routes.conf",
        "secure-callout.conf",
    ] {
        let out = std::process::Command::new(super::live_harness::server_bin())
            .arg("-t")
            .arg("-c")
            .arg(super::live_harness::ops_conf(conf))
            .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
            .output()
            .expect("nats-server -t");
        assert!(
            out.status.success(),
            "{conf}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let _ = PeerIdentitySelector::DnsName(SERVER_NAME.into());
    let _ = secure_server;
}
