//! Listener bounds: handshake timeout, concurrent-handshake cap, header
//! size, body size, idle timeout.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use opensesame_domain::transport::{PeerIdentitySelector, TlsVersion, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, ListenerLimits, ServerNamePolicy,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn limits() -> ListenerLimits {
    ListenerLimits {
        max_concurrent_handshakes: 1,
        handshake_timeout: Duration::from_millis(400),
        idle_timeout: Duration::from_millis(700),
        max_header_bytes: 8192,
        max_body_bytes: 1024,
        usable_for: Duration::from_secs(60),
    }
}

async fn bounded() -> (Served, Arc<rustls::ClientConfig>) {
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let gens = generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let served = serve(
        gens.clone(),
        profile_fn_with(TransportPolicy::MtlsRequired, limits()),
        router(gens, Hits::default()),
    )
    .await;
    let leaf = client_ca.issue_client(PeerIdentitySelector::DnsName("c.internal".into()));
    let profile = ClientProfile {
        server_trust: private_root("servers", &server_ca),
        server_name: ServerNamePolicy::Dns("localhost".into()),
        identity: Some(Arc::new(leaf.identity())),
        min_version: TlsVersion::Tls13,
    };
    (served, Arc::new(client_config(&profile).unwrap()))
}

#[tokio::test]
async fn stalled_handshake_times_out_and_frees_its_slot() {
    let (served, config) = bounded().await;
    // A TCP connection that never speaks TLS holds the only handshake slot.
    let mut silent = tokio::net::TcpStream::connect(served.addr).await.unwrap();
    let started = std::time::Instant::now();
    // The next real client must wait for the slot, then succeed.
    let (status, _) = tokio::time::timeout(
        Duration::from_secs(3),
        raw_get(config, served.addr, localhost(), "/health"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(status, 200);
    assert!(
        started.elapsed() >= Duration::from_millis(350),
        "waited for the stalled handshake to time out"
    );
    // The silent socket was closed by the server.
    let mut buf = [0u8; 8];
    let closed = tokio::time::timeout(Duration::from_secs(2), silent.read(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed, 0);
    assert_eq!(served.counters.handshakes_failed(), 1);
}

#[tokio::test]
async fn oversized_headers_and_bodies_are_refused() {
    let (served, config) = bounded().await;
    let mut stream = connect(config.clone(), served.addr, localhost())
        .await
        .unwrap();
    let huge = "x".repeat(20_000);
    let req = format!("GET /health HTTP/1.1\r\nHost: localhost\r\nX-Big: {huge}\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out)).await;
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.starts_with("HTTP/1.1 431") || text.starts_with("HTTP/1.1 400") || text.is_empty(),
        "{text}"
    );
    assert!(!text.contains("\r\n\r\nok"), "{text}");

    let mut stream = connect(config, served.addr, localhost()).await.unwrap();
    let body = "b".repeat(4096);
    let req = format!("POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out)).await;
    let text = String::from_utf8_lossy(&out);
    assert!(text.starts_with("HTTP/1.1 413"), "{text}");
}

#[tokio::test]
async fn idle_connection_is_closed() {
    let (served, config) = bounded().await;
    let mut stream = connect(config, served.addr, localhost()).await.unwrap();
    assert_eq!(request_on(&mut stream, "/health").await.unwrap().0, 200);
    let mut buf = [0u8; 8];
    let started = std::time::Instant::now();
    let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buf))
        .await
        .expect("closed before the test timeout");
    assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    assert!(started.elapsed() >= Duration::from_millis(500));
}

#[tokio::test]
async fn connection_close_is_honored_by_the_server() {
    let (served, config) = bounded().await;
    let mut stream = connect(config, served.addr, localhost()).await.unwrap();
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = Vec::new();
    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_millis(500), stream.read_to_end(&mut out))
        .await
        .expect("server closes after Connection: close, well before the idle timeout")
        .unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert!(text.ends_with("ok"), "{text}");
    assert!(started.elapsed() < Duration::from_millis(500));
}
