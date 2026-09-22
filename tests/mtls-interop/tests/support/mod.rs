//! Shared scaffolding for the interop suites.
//!
//! The router below is the *production* authorization path: a peer verified
//! by `opensesame_transport_security`'s listener, admitted by
//! `opensesame_domain::transport::ServiceCaller::admit` and then checked
//! against the binding's operation allowlist. Nothing here re-implements a
//! check; the point is to expose the two outcomes separately so a test can
//! tell a TLS refusal from an authorization denial.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::{Extensions, StatusCode};
use axum::routing::get;
use axum::Router;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    ServiceCaller, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::{
    Generation, PeerExtension, SecureListener, ServerProfile, TlsIdentity, TransportGenerations,
    TrustBundle,
};

/// The trust profile every interop binding is filed under.
pub const PROFILE: &str = "iop-private-root";
/// The operation the bound peer is allowed to perform.
pub const ALLOWED_OPERATION: &str = "nats.callout.decide";
/// An operation no interop binding allows.
pub const FORBIDDEN_OPERATION: &str = "transport.probe";

/// State the probe handlers need: the binding set and the live generation.
#[derive(Clone)]
pub struct Admission {
    pub bindings: Arc<ServiceBindingSet>,
    pub generation: u64,
}

fn profile_ref() -> TrustProfileRef {
    TrustProfileRef {
        name: PROFILE.to_string(),
    }
}

/// One deployment-scoped binding naming `peer` for the bridge purpose.
#[must_use]
pub fn binding(id: &str, peer: PeerIdentitySelector) -> ServiceBinding {
    ServiceBinding {
        id: id.to_string(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: profile_ref(),
        peer,
        service_principal: format!("svc:{id}"),
        purpose: BindingPurpose::NatsAuthBridge,
        allowed_operations: vec![ALLOWED_OPERATION.to_string()],
        allowed_audiences: vec!["host".to_string()],
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

/// `/probe/{operation}`: admit, then require that exact operation.
async fn probe(
    State(state): State<Admission>,
    axum::extract::Path(operation): axum::extract::Path<String>,
    extensions: Extensions,
) -> (StatusCode, String) {
    let Some(PeerExtension(peer)) = extensions.get::<PeerExtension>().cloned() else {
        return (
            StatusCode::FORBIDDEN,
            TransportError::PeerNotBound.code().to_string(),
        );
    };
    let now = chrono::Utc::now();
    let caller = match ServiceCaller::admit(
        (*peer).clone(),
        &BindingScope::Deployment,
        &state.bindings,
        BindingPurpose::NatsAuthBridge,
        state.generation,
        state.generation,
        now,
    ) {
        Ok(caller) => caller,
        Err(error) => return (StatusCode::FORBIDDEN, error.code().to_string()),
    };
    match caller.require_operation(&operation) {
        Ok(()) => (
            StatusCode::OK,
            format!(
                "admitted {} {}",
                caller.binding.service_principal,
                caller.peer.leaf_thumbprint_sha256()
            ),
        ),
        Err(error) => (StatusCode::FORBIDDEN, error.code().to_string()),
    }
}

/// The router every IOP-TLS listener serves.
#[must_use]
pub fn router(bindings: ServiceBindingSet) -> Router {
    Router::new()
        .route("/probe/{operation}", get(probe))
        .with_state(Admission {
            bindings: Arc::new(bindings),
            generation: 1,
        })
}

/// A live `MtlsRequired` listener on an ephemeral loopback port, built from
/// PEM files on disk exactly as a deployment would load them.
pub struct Listener {
    pub port: u16,
    handle: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Listener {
    /// Bind and start serving.
    ///
    /// # Errors
    ///
    /// The material was refused, or the socket could not be bound.
    pub async fn start(
        policy: TransportPolicy,
        server_chain: &std::path::Path,
        server_key: &std::path::Path,
        client_anchors: &std::path::Path,
        app: Router,
    ) -> Result<Self> {
        let identity = Arc::new(TlsIdentity::from_pem(
            &std::fs::read(server_chain)?,
            &secret(std::fs::read(server_key)?),
        )?);
        let trust = TrustBundle::from_pem(
            profile_ref(),
            TrustProfileKind::PrivateRoot,
            &std::fs::read(client_anchors)?,
        )?;
        let mut peer_trust = BTreeMap::new();
        peer_trust.insert(profile_ref(), trust);
        let generations = TransportGenerations::new(Generation {
            number: 1,
            identity: Some(Arc::clone(&identity)),
            peer_trust,
            activated_at: chrono::Utc::now(),
            withdrawn: None,
        });
        let listener = SecureListener::bind(
            "127.0.0.1:0".parse()?,
            Arc::clone(&generations),
            move |generation| {
                let identity = generation
                    .identity
                    .clone()
                    .ok_or(TransportError::IdentityMissing)?;
                let mut profile = ServerProfile::new(policy, identity, "iop-tls");
                if policy.authenticates_client() {
                    profile.client_trust = Some(generation.trust(&profile_ref())?.clone());
                }
                Ok(profile)
            },
        )
        .await?;
        let port = listener.local_addr().port();
        let (shutdown, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = listener
                .serve_until(app, async {
                    let _ = rx.await;
                })
                .await;
        });
        Ok(Self {
            port,
            handle,
            shutdown,
        })
    }

    /// Stop serving and wait for the task.
    pub async fn stop(self) {
        let _ = self.shutdown.send(());
        let _ = self.handle.await;
    }
}

fn secret(bytes: Vec<u8>) -> opensesame_transport_security::SecretBytes {
    secrecy::SecretBox::new(Box::new(bytes))
}

/// The URI-SAN selector a client leaf presents.
#[must_use]
pub fn uri(value: &str) -> PeerIdentitySelector {
    PeerIdentitySelector::SpiffeId(value.to_string())
}
