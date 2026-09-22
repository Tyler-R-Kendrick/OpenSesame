//! Shared harness for the lifecycle tests.
//!
//! Everything cryptographic comes from `opensesame_transport_security::testkit`,
//! so a test's CA, leaves and keys are generated in-process, live only in
//! memory, and are never written to the repository. The listener the
//! activation and revocation tests drive is a **real** [`SecureListener`] with
//! a real rustls client on the other end — no mock swaps a generation and
//! calls it proof.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Utc};
use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportError, TransportPolicy, TrustProfileKind,
    TrustProfileRef,
};
use opensesame_domain::OrganizationId;
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf, LeafSpec};
use opensesame_transport_security::{
    client_config, enforce_current_generation, ClientProfile, Generation, GenerationCandidate,
    ListenerCounters, SecureListener, ServerNamePolicy, ServerProfile, TlsIdentity,
    TransportGenerations, TrustBundle,
};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::app_state::AppState;

/// The peer-trust profile every harness listener verifies clients against.
pub const CLIENTS: &str = "clients";
/// The listener id the harness uses.
pub const LISTENER: &str = "lifecycle-tls";

#[must_use]
pub fn profile_ref(name: &str) -> TrustProfileRef {
    TrustProfileRef::new(name).expect("profile ref")
}

#[must_use]
pub fn private_root(name: &str, ca: &DisposableCa) -> TrustBundle {
    TrustBundle::from_pem(
        profile_ref(name),
        TrustProfileKind::PrivateRoot,
        &ca.root_pem(),
    )
    .expect("trust bundle")
}

/// A state with the lifecycle handle already on it (`test_demo_state` builds
/// it), plus a canonical organization.
pub async fn state() -> AppState {
    crate::app_state::test_demo_state().await
}

#[must_use]
pub fn other_org() -> OrganizationId {
    OrganizationId::new()
}

/// Generations serving `server`, trusting `client_ca` for peers.
#[must_use]
pub fn generations(server: TlsIdentity, client_ca: &DisposableCa) -> Arc<TransportGenerations> {
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(server)),
        peer_trust: [(profile_ref(CLIENTS), private_root(CLIENTS, client_ca))].into(),
        own_trust: None,
        identity_required: true,
    };
    TransportGenerations::new(
        candidate
            .into_generation(1, Utc::now())
            .expect("generation 1"),
    )
}

/// The profile function for an `mtls_required` listener, with the lifecycle
/// state's denylist hook wired in exactly as the runtime wires it.
pub fn profile_fn(
    state: &AppState,
) -> impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static {
    let deny = state.transport_lifecycle.deny_hook();
    move |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        let mut profile = ServerProfile::new(TransportPolicy::MtlsRequired, identity, LISTENER);
        profile.client_trust = Some(generation.trust(&profile_ref(CLIENTS))?.clone());
        profile.deny_thumbprint = deny.clone();
        Ok(profile)
    }
}

/// `/health` unguarded, `/protected` behind `enforce_current_generation`.
#[must_use]
pub fn router(generations: Arc<TransportGenerations>) -> Router {
    let guarded = Router::new()
        .route("/protected", get(|| async { "protected ok" }))
        .layer(axum::middleware::from_fn_with_state(
            generations,
            enforce_current_generation,
        ));
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(guarded)
}

/// A served listener that aborts on drop.
pub struct Served {
    pub addr: SocketAddr,
    pub counters: Arc<ListenerCounters>,
    task: Option<tokio::task::JoinHandle<Result<(), TransportError>>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub async fn serve(
    generations: Arc<TransportGenerations>,
    profile: impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static,
    app: Router,
) -> Served {
    let listener = SecureListener::bind("127.0.0.1:0".parse().expect("addr"), generations, profile)
        .await
        .expect("bind");
    let addr = listener.local_addr();
    let counters = listener.counters();
    Served {
        addr,
        counters,
        task: Some(tokio::spawn(listener.serve(app))),
    }
}

/// A rustls client config presenting `identity`, trusting `server_ca`.
#[must_use]
pub fn client(
    server_ca: &DisposableCa,
    identity: Option<Arc<TlsIdentity>>,
) -> Arc<rustls::ClientConfig> {
    let profile = ClientProfile {
        server_trust: private_root("servers", server_ca),
        server_name: ServerNamePolicy::Dns("localhost".into()),
        identity,
        min_version: TlsVersion::Tls13,
    };
    Arc::new(client_config(&profile).expect("client config"))
}

/// Open a TLS connection and keep it: the "existing connection" of
/// AT-TLS-REVOKEDLIVE.
pub async fn connect(
    config: Arc<rustls::ClientConfig>,
    addr: SocketAddr,
) -> Result<TlsStream<TcpStream>, String> {
    let tcp = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("tcp: {e}"))?;
    let name = ServerName::try_from("localhost").expect("server name");
    TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|e| format!("tls: {e}"))
}

/// One HTTP/1.1 request on an already-open stream, leaving it usable.
pub async fn request_on(
    stream: &mut TlsStream<TcpStream>,
    path: &str,
) -> Result<(u16, String), String> {
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream
            .read(&mut byte)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if read == 0 {
            return Err("eof before headers".into());
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("no status in {head}"))?;
    let length: usize = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse().unwrap_or(0))
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| format!("body: {e}"))?;
    Ok((status, String::from_utf8_lossy(&body).to_string()))
}

/// A client leaf with one DNS selector under `ca`.
#[must_use]
pub fn client_leaf(ca: &DisposableCa, name: &str) -> IssuedLeaf {
    ca.issue_client(PeerIdentitySelector::DnsName(name.to_owned()))
}

/// A server leaf for `localhost` valid in an explicit window.
#[must_use]
pub fn server_leaf_between(
    ca: &DisposableCa,
    not_before: DateTime<Utc>,
    not_after: DateTime<Utc>,
) -> IssuedLeaf {
    ca.issue_with(&LeafSpec::server("localhost").valid_between(not_before, not_after))
}

/// Seed an active internal authority for `organization` so issuance has
/// something to sign with. Mirrors `routes::certs::persist_internal_ca`.
pub async fn seed_authority(state: &AppState, organization: &OrganizationId) -> String {
    let organization = organization.to_string();
    let key = state
        .connection_broker
        .config()
        .key()
        .copied()
        .expect("test state has a connection sealing key");
    let ca = crate::dev_pki::generate_dev_ca().expect("dev ca");
    let authority_id = format!("ca:opensesame:{organization}");
    let plaintext = serde_json::to_vec(&ca).expect("encode ca");
    let sealed = opensesame_connection_broker::crypto::seal_scoped(
        &key,
        "certificate_authority",
        &authority_id,
        &organization,
        &plaintext,
    )
    .expect("seal ca");
    let now = Utc::now().to_rfc3339();
    let authority = opensesame_storage::StoredCertificateAuthority {
        id: authority_id.clone(),
        organization_id: organization.clone(),
        issuer_kind: "opensesame_internal".into(),
        issuer_connection_id: None,
        display_name: "test private CA".into(),
        public_metadata_json: serde_json::json!({ "certificate": ca.cert_pem }).to_string(),
        sealed_material: opensesame_storage::SealedCertificateMaterial {
            key_id: crate::managed_certs::KEY_ID.into(),
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            aad_digest: sealed.aad_digest,
        },
        is_default: true,
        status: "active".into(),
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    state
        .db
        .insert_certificate_authority(&authority)
        .await
        .expect("insert authority");
    authority_id
}

/// A state with an authority seeded for its own organization.
pub async fn state_with_authority() -> AppState {
    let state = state().await;
    seed_authority(&state, &state.connection_organization).await;
    state
}

/// The canonical listener issuance request.
#[must_use]
pub fn listener_request(
    dns: &str,
) -> crate::transport_lifecycle::issuance::TransportIssuanceRequest {
    crate::transport_lifecycle::issuance::TransportIssuanceRequest {
        purpose: crate::managed_certs_tls::TransportPurpose::Listener,
        selector: PeerIdentitySelector::DnsName(dns.to_owned()),
        validity_seconds: Some(7 * 24 * 3_600),
        renew_before_seconds: Some(3_600),
        managed: true,
    }
}
