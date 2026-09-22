//! One accepted connection: bounded handshake, peer attestation, then HTTP
//! service with the connection's provenance and peer stamped on every
//! request.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use chrono::{DateTime, Utc};
use hyper::body::Incoming;
use hyper::Request;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::Watcher;
use opensesame_domain::transport::attest::AttestedPeer;
use opensesame_domain::transport::{EvidenceSource, TlsVersion, TransportError, VerifiedPeer};
use rustls::server::ServerConnection;
use rustls::ProtocolVersion;
use tokio::net::TcpStream;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;

use crate::error::{classify_tls_error, malformed};
use crate::generations::TransportGenerations;
use crate::guard::PeerDenyHook;
use crate::idle_io::IdleTimeout;
use crate::leaf::ParsedLeaf;
use crate::listener::ListenerCounters;
use crate::provenance::{tls_provenance, ListenerProvenance, PeerExtension};
use crate::server::ServerProfile;

/// A generation's prepared listener state.
pub(crate) struct Prepared {
    pub(crate) number: u64,
    pub(crate) acceptor: TlsAcceptor,
    pub(crate) profile: Arc<ServerProfile>,
}

/// What the handshake established for this connection.
struct ConnectionContext {
    provenance: ListenerProvenance,
    peer: Option<Arc<VerifiedPeer>>,
    deny: PeerDenyHook,
}

/// Run the handshake under the profile's bounds and attest the peer.
///
/// # Errors
///
/// The classified handshake failure; `EvidenceRevoked` when the process-wide
/// or the listener's denylist refuses the leaf; `IdentityMissing` when an authenticating
/// policy somehow completed without a peer certificate (cannot happen with
/// `WebPkiClientVerifier`, kept as a fail-closed check).
async fn handshake(
    prepared: &Prepared,
    generations: &TransportGenerations,
    stream: TcpStream,
    counters: &ListenerCounters,
) -> Result<(TlsStream<TcpStream>, ConnectionContext), TransportError> {
    let limits = prepared.profile.limits;
    let accepted = tokio::time::timeout(limits.handshake_timeout, prepared.acceptor.accept(stream))
        .await
        .map_err(|_| malformed("handshake timed out"))?
        .map_err(|e| classify_io_error(&e))?;
    let (_, connection) = accepted.get_ref();
    if matches!(
        connection.handshake_kind(),
        Some(rustls::HandshakeKind::Resumed)
    ) {
        counters.record_resumed();
    }
    let policy = prepared.profile.policy;
    let peer = if policy.authenticates_client() {
        let verified = attest(connection, &prepared.profile, prepared.number, Utc::now())?;
        let thumbprint = verified.leaf_thumbprint_sha256();
        if generations.is_denied(thumbprint) || (prepared.profile.deny_thumbprint)(thumbprint) {
            return Err(TransportError::EvidenceRevoked);
        }
        Some(Arc::new(verified))
    } else {
        None
    };
    let context = ConnectionContext {
        provenance: tls_provenance(&prepared.profile.listener_id, policy, prepared.number),
        peer,
        deny: PeerDenyHook(Arc::clone(&prepared.profile.deny_thumbprint)),
    };
    Ok((accepted, context))
}

fn classify_io_error(error: &std::io::Error) -> TransportError {
    match error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        Some(tls) => classify_tls_error(tls),
        None => malformed(format!("handshake i/o: {}", error.kind())),
    }
}

/// Build the verified peer from the certificate rustls verified.
fn attest(
    connection: &ServerConnection,
    profile: &ServerProfile,
    generation: u64,
    now: DateTime<Utc>,
) -> Result<VerifiedPeer, TransportError> {
    let chain = connection
        .peer_certificates()
        .ok_or(TransportError::IdentityMissing)?;
    let leaf_der = chain.first().ok_or(TransportError::IdentityMissing)?;
    let leaf = ParsedLeaf::parse(leaf_der)?;
    let trust = profile
        .client_trust
        .as_ref()
        .ok_or(TransportError::TrustUnknown)?;
    let tls_version = match connection.protocol_version() {
        Some(ProtocolVersion::TLSv1_3) => TlsVersion::Tls13,
        Some(ProtocolVersion::TLSv1_2) => TlsVersion::Tls12,
        other => return Err(malformed(format!("unexpected protocol version {other:?}"))),
    };
    let remaining = (leaf.not_after - now).to_std().unwrap_or(Duration::ZERO);
    let usable_for = profile.limits.usable_for.min(remaining);
    let usable_until = now + chrono::Duration::from_std(usable_for).unwrap_or_default();
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: leaf.selectors.clone(),
        leaf_thumbprint_sha256: leaf.thumbprint_sha256.clone(),
        not_before: leaf.not_before,
        not_after: leaf.not_after,
        trust_profile: trust.profile().clone(),
        trust_generation: generation,
        credential_generation: generation,
        listener: profile.listener_id.clone(),
        policy: profile.policy,
        tls_version,
        authenticated_at: now,
        usable_until,
        ingress: None,
    }
    .into_verified()
}

/// Handshake, then serve HTTP on the connection until it closes, idles out,
/// or the graceful shutdown completes.
pub(crate) async fn serve_connection(
    prepared: Arc<Prepared>,
    generations: Arc<TransportGenerations>,
    stream: TcpStream,
    router: Router,
    counters: Arc<ListenerCounters>,
    graceful: Option<Watcher>,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    let (tls, context) = match handshake(&prepared, &generations, stream, &counters).await {
        Ok(done) => done,
        Err(error) => {
            counters.record_failed();
            tracing::debug!(code = error.code(), "tls handshake refused");
            return;
        }
    };
    drop(permit);
    counters.record_ok();
    let limits = prepared.profile.limits;
    let io = TokioIo::new(IdleTimeout::new(tls, limits.idle_timeout));
    let context = Arc::new(context);
    let service = hyper::service::service_fn(move |mut req: Request<Incoming>| {
        req.extensions_mut().insert(context.provenance.clone());
        if let Some(peer) = &context.peer {
            req.extensions_mut().insert(PeerExtension(Arc::clone(peer)));
            req.extensions_mut().insert(context.deny.clone());
        }
        router.clone().oneshot(req)
    });
    let mut builder = Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .max_buf_size(limits.max_header_bytes)
        .header_read_timeout(limits.idle_timeout);
    builder
        .http2()
        .timer(TokioTimer::new())
        .max_header_list_size(u32::try_from(limits.max_header_bytes).unwrap_or(u32::MAX))
        .keep_alive_interval(Some(limits.idle_timeout / 2))
        .keep_alive_timeout(limits.idle_timeout);
    let connection = builder.serve_connection(io, service);
    let result = match graceful {
        Some(graceful) => graceful.watch(connection).await,
        None => connection.await,
    };
    if let Err(error) = result {
        tracing::debug!(error = %error, "secure connection ended with error");
    }
}
