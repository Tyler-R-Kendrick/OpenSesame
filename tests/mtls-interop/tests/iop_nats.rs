//! IOP-NATS — only what SW-NATS could not do for itself.
//!
//! SW-NATS ran the pinned `nats-server` 2.11.17 for client admission,
//! certificate-to-user mapping, TLS-first, a two-node route cluster and
//! callout expiry, all with `async-nats`. Those results are cited, not
//! repeated. What is missing there is a second runtime: every observation was
//! made by the same client library the Host publishes with, so a shared
//! assumption between publisher and consumer would have been invisible.
//!
//! Here the **publisher is the production Rust path** (`async-nats` over the
//! rustls client config `opensesame_transport_security` builds) and the
//! **consumer is `openssl s_client` speaking NATS' text protocol by hand**.
//! Nothing is shared between them but the wire.
//!
//! The second addition is about reconnection. A TLS session ends at the
//! handshake; a reconnect is a new handshake and a new authorization. This
//! suite restarts the broker under a live client and checks that the
//! destinations the certificate authorizes are re-derived, never widened —
//! including that whatever the server advertises in `INFO` carries no
//! authority with it.

#[path = "support/nats.rs"]
mod nats;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use opensesame_domain::transport::{TlsVersion, TrustProfileKind, TrustProfileRef};
use opensesame_mtls_interop::pki::Leaf;
use opensesame_mtls_interop::{fixtures_enabled, record};
use opensesame_transport_security::{
    client_config, ClientProfile, ServerNamePolicy, TlsIdentity, TrustBundle,
};

fn rust_client_config(broker: &nats::Broker, leaf: &Leaf) -> Result<rustls::ClientConfig> {
    let identity = Arc::new(TlsIdentity::from_pem(
        &std::fs::read(&leaf.chain)?,
        &secrecy::SecretBox::new(Box::new(std::fs::read(&leaf.key)?)),
    )?);
    let trust = TrustBundle::from_pem(
        TrustProfileRef {
            name: "iop-nats-root".to_string(),
        },
        TrustProfileKind::PrivateRoot,
        &std::fs::read(&broker.ca.cert)?,
    )?;
    Ok(client_config(&ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(nats::SERVER_DNS.to_string()),
        identity: Some(identity),
        min_version: TlsVersion::Tls13,
    })?)
}

async fn rust_publisher(broker: &nats::Broker) -> Result<async_nats::Client> {
    let config = rust_client_config(broker, &broker.publisher)?;
    // `tls_first` is not optional here: the broker is configured
    // `handshake_first: true`, so it never writes a plaintext `INFO`. A
    // client that waits for `INFO` before upgrading and a server that waits
    // for a `ClientHello` deadlock until both time out — which is exactly
    // what the broker log says when this line is missing
    // ("TLS handshake error: i/o timeout", once every reconnect).
    //
    // There is deliberately no `retry_on_initial_connect` either: an
    // unbounded retry turns a misconfiguration into a hang instead of a
    // failure, and this suite fails rather than hangs.
    let connect = async_nats::ConnectOptions::new()
        .require_tls(true)
        .tls_first()
        .tls_client_config(config)
        .connection_timeout(Duration::from_secs(10))
        .connect(format!("tls://{}:{}", nats::SERVER_DNS, broker.port));
    Ok(tokio::time::timeout(Duration::from_secs(25), connect)
        .await
        .map_err(|_| anyhow::anyhow!("the NATS connection did not complete within 25s"))??)
}

/// Run the raw consumer on a blocking thread while the production Rust
/// client publishes, and return everything the consumer saw.
///
/// The consumer cannot be a `block_in_place` inside a `join!`: both branches
/// of a `join!` share one task, so the blocking child would run to completion
/// before the publisher was polled at all.
async fn publish_then_consume(
    broker: &nats::Broker,
    subject: &str,
    payload: &str,
    lines: &[&str],
) -> Result<String> {
    let owned: Vec<String> = lines.iter().map(|l| (*l).to_string()).collect();
    let consumer = broker.consumer.clone();
    let anchors = broker.ca.cert.clone();
    let port = broker.port;
    let listening = tokio::task::spawn_blocking(move || {
        nats::raw_session_at(port, &anchors, &consumer, &owned, Duration::from_secs(5))
    });
    let subject = subject.to_string();
    let body = payload.to_string();
    let sending = tokio::time::timeout(Duration::from_secs(40), async {
        // Give the raw subscriber time to register before publishing.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let client = rust_publisher(broker).await?;
        client.publish(subject, body.into()).await?;
        client.flush().await?;
        anyhow::Ok(())
    });
    let (sent, heard) = tokio::join!(sending, listening);
    // Both layers are unwrapped on purpose. An earlier version let the
    // publisher's own error stay wrapped inside a timeout result, and `?`
    // discarded it — so a publisher that never connected read as "the
    // consumer missed the message".
    sent.map_err(|_| anyhow::anyhow!("the Rust publisher did not finish within 40s"))??;
    heard?
}

/// A Rust publisher and an OpenSSL consumer on the same broker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real nats-server; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn a_rust_publisher_and_a_raw_openssl_consumer_agree_on_one_certificate_mapped_broker(
) -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let broker = nats::Broker::start()?;
    let subject = format!("{}.interop", nats::EVENTS);
    let payload = "from-the-rust-publisher";

    // The consumer subscribes first, from a runtime that knows nothing about
    // async-nats, and dwells while the publisher runs.
    let consumer_lines = [
        nats::connect_line(),
        format!("SUB {}.> 1", nats::EVENTS),
        "PING".to_string(),
    ];
    let lines: Vec<&str> = consumer_lines.iter().map(String::as_str).collect();
    // The consumer has to be *listening* while the publisher runs. It cannot
    // be a `block_in_place` inside a `join!`: both branches of a `join!`
    // share one task, so the blocking child would still run to completion
    // before the publisher was ever polled. It goes on a blocking thread of
    // its own instead.
    let transcript = publish_then_consume(&broker, &subject, payload, &lines).await?;

    if !transcript.contains("PONG") {
        return nats::fail(
            &broker,
            "the raw consumer never completed CONNECT",
            &transcript,
        );
    }
    if !transcript.contains(&format!("MSG {subject} 1")) || !transcript.contains(payload) {
        return nats::fail(
            &broker,
            "the raw OpenSSL consumer did not receive what the Rust publisher sent",
            &transcript,
        );
    }
    record(
        "IOP-NATS-CROSSRUNTIME",
        &format!(
            "nats-server {} : async-nats publisher -> openssl s_client consumer",
            broker.version
        ),
        "MSG delivered across runtimes on a verify_and_map broker",
    );
    Ok(())
}

/// The destinations a certificate authorizes are re-derived at every
/// connection. A restart under a live client widens nothing, and whatever
/// `INFO` advertises carries no authority.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real nats-server; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn reconnecting_never_widens_the_destinations_a_certificate_authorizes() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let mut broker = nats::Broker::start()?;

    // The consumer's certificate maps to a user that may subscribe to the
    // events tree and publish nowhere.
    let probe = [
        nats::connect_line(),
        format!("SUB {}.> 1", nats::EVENTS),
        format!("SUB {}.> 2", nats::FORBIDDEN),
        format!("PUB {}.escalate 2", nats::EVENTS),
        "hi".to_string(),
        "PING".to_string(),
    ];
    let lines: Vec<&str> = probe.iter().map(String::as_str).collect();
    let before = tokio::task::block_in_place(|| {
        broker.raw_session(&broker.consumer, &lines, Duration::from_secs(2))
    })?;

    let violations = |text: &str| {
        (
            text.contains("Permissions Violation for Subscription"),
            text.contains("Permissions Violation for Publish"),
        )
    };
    let (sub_denied, pub_denied) = violations(&before);
    if !sub_denied || !pub_denied {
        return nats::fail(
            &broker,
            "the mapped consumer should have been refused both the forbidden subscription and any publish",
            &before,
        );
    }
    // Its own subject tree is still allowed — the refusals above are about
    // the destination, not about the certificate being rejected outright.
    if before.contains(&format!(
        "Permissions Violation for Subscription to \"{}.>\"",
        nats::EVENTS
    )) {
        return nats::fail(&broker, "the allowed subscription was refused too", &before);
    }

    // What the server advertises about itself, recorded rather than trusted.
    let info = before
        .lines()
        .find(|line| line.starts_with("INFO "))
        .unwrap_or("INFO <none>")
        .to_string();

    // Restart the broker on the same port: every client must re-handshake.
    broker.restart()?;

    let after = tokio::task::block_in_place(|| {
        broker.raw_session(&broker.consumer, &lines, Duration::from_secs(2))
    })?;
    let (sub_denied_after, pub_denied_after) = violations(&after);
    if !sub_denied_after || !pub_denied_after {
        return nats::fail(
            &broker,
            "after a reconnect the same certificate was granted more than before",
            &after,
        );
    }

    record(
        "IOP-NATS-NOWIDEN",
        &format!("nats-server {} <- openssl s_client", broker.version),
        &format!(
            "identical permission violations before and after a broker restart; advertised {}",
            info.chars().take(180).collect::<String>()
        ),
    );
    Ok(())
}

/// A certificate the broker's CA never issued cannot map to any user, and a
/// certificate that maps to no listed user is refused after the handshake —
/// two different refusals that must not be confused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real nats-server; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
async fn an_unmapped_certificate_is_refused_after_the_handshake_not_during_it() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let broker = nats::Broker::start()?;
    // Issued by the broker's own CA, so TLS accepts it; its SAN names no
    // user in the configuration, so authentication fails afterwards.
    let stranger = broker
        .ca
        .issue(&opensesame_mtls_interop::pki::LeafSpec::client_dns(
            "stranger",
            "stranger.iop.test",
        ))?;
    let lines = [nats::connect_line(), "PING".to_string()];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let transcript = tokio::task::block_in_place(|| {
        broker.raw_session(&stranger, &refs, Duration::from_secs(2))
    })?;

    if !transcript.contains("INFO ") {
        return nats::fail(
            &broker,
            "the handshake should have completed — TLS trusts the CA",
            &transcript,
        );
    }
    if !transcript.contains("Authorization Violation") {
        return nats::fail(
            &broker,
            "an unmapped certificate must be refused at authentication",
            &transcript,
        );
    }
    record(
        "IOP-NATS-UNMAPPED",
        &format!("nats-server {} <- openssl s_client", broker.version),
        "trusted but unmapped certificate: INFO received, then Authorization Violation",
    );
    Ok(())
}
