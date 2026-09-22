//! Request extensions that say *which listener* a request arrived on and
//! *who* the handshake authenticated.
//!
//! [`ListenerProvenance`] is inserted for every request by every listener
//! (the secure one, and the plain one through
//! [`plain_provenance_layer`]). [`PeerExtension`] is inserted only when a
//! client certificate was verified at the handshake; on an `MtlsRequired`
//! or `TrustedIngress` listener a request without it cannot exist, because
//! rustls does not complete the handshake without one.

use std::sync::Arc;
use std::task::{Context, Poll};

use http::Request;
use opensesame_domain::transport::{TransportPolicy, VerifiedPeer};
use tower::{Layer, Service};

/// Which listener carried the request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListenerProvenance {
    Plain {
        listener_id: String,
    },
    Tls {
        listener_id: String,
        policy: TransportPolicy,
        generation: u64,
    },
}

impl ListenerProvenance {
    #[must_use]
    pub fn listener_id(&self) -> &str {
        match self {
            Self::Plain { listener_id } | Self::Tls { listener_id, .. } => listener_id,
        }
    }

    /// The listener's policy (`ExistingLocal` for the plain listener).
    #[must_use]
    pub fn policy(&self) -> TransportPolicy {
        match self {
            Self::Plain { .. } => TransportPolicy::ExistingLocal,
            Self::Tls { policy, .. } => *policy,
        }
    }
}

/// The verified peer for this connection.
#[derive(Clone, Debug)]
pub struct PeerExtension(pub Arc<VerifiedPeer>);

/// Inserts one fixed [`ListenerProvenance`] into every request.
#[derive(Clone, Debug)]
pub struct ProvenanceLayer {
    provenance: ListenerProvenance,
}

impl<S> Layer<S> for ProvenanceLayer {
    type Service = ProvenanceService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ProvenanceService {
            inner,
            provenance: self.provenance.clone(),
        }
    }
}

/// The service [`ProvenanceLayer`] wraps around a router.
#[derive(Clone, Debug)]
pub struct ProvenanceService<S> {
    inner: S,
    provenance: ListenerProvenance,
}

impl<S, B> Service<Request<B>> for ProvenanceService<S>
where
    S: Service<Request<B>>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<B>) -> Self::Future {
        req.extensions_mut().insert(self.provenance.clone());
        self.inner.call(req)
    }
}

/// The layer a plain (non-TLS) listener applies so its requests carry
/// `ListenerProvenance::Plain { listener_id }`.
#[must_use]
pub fn plain_provenance_layer(listener_id: &str) -> ProvenanceLayer {
    ProvenanceLayer {
        provenance: ListenerProvenance::Plain {
            listener_id: listener_id.to_owned(),
        },
    }
}

/// The layer a secure listener applies per connection.
#[must_use]
pub(crate) fn tls_provenance(
    listener_id: &str,
    policy: TransportPolicy,
    generation: u64,
) -> ListenerProvenance {
    ListenerProvenance::Tls {
        listener_id: listener_id.to_owned(),
        policy,
        generation,
    }
}
