//! The request-scoped attachment of originating-client evidence.
//!
//! [`originating_peer_layer`] sits in front of the router on every listener
//! and does one of two things with the `Client-Cert*` fields:
//!
//! - On a `Tls { policy: TrustedIngress }` listener, from a peer that
//!   [`IngressAdmission`] accepts: parse, re-validate, and attach the result
//!   to **this request** as [`OriginatingPeerExtension`]. A problem with the
//!   fields is answered `403` here; the handler never runs (AT-INGRESS-PARSER).
//!   A peer the admission does not accept is refused outright: the listener
//!   exists for bound ingresses only (AT-INGRESS-WRONGPEER).
//! - Everywhere else — the plain listener, a `ServerTls` or `MtlsRequired`
//!   listener, any listener the layer is not told about — the fields are
//!   removed and nothing is attached (AT-INGRESS-SPOOF).
//!
//! The extension is inserted into the request's own extensions, never into
//! connection state, so two requests on one kept-alive connection from the
//! ingress each see only their own originating identity, and a request with
//! no fields sees none (AT-INGRESS-POOL).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::http::{header, HeaderValue, Request, Response, StatusCode};
use chrono::Utc;
use opensesame_domain::transport::{TransportError, TransportPolicy, VerifiedPeer};
use opensesame_transport_security::{ListenerProvenance, PeerExtension, TrustBundle};
use tower::{Layer, Service};

use crate::admission::IngressAdmission;
use crate::chain::parse_client_cert_fields;
use crate::error::{Field, IngressError};
use crate::fields::has_client_cert_fields;
use crate::limits::IngressLimits;
use crate::verify::verify_originating;

/// The originating client's verified evidence, for this request only.
#[derive(Clone, Debug)]
pub struct OriginatingPeerExtension(pub Arc<VerifiedPeer>);

struct Shared {
    admission: Arc<dyn IngressAdmission>,
    trust: Arc<TrustBundle>,
    limits: IngressLimits,
}

/// Builds the layer. `trust` is the originating-client bundle
/// (`OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`), never the bundle that
/// verified the ingress itself.
#[must_use]
pub fn originating_peer_layer(
    admission: Arc<dyn IngressAdmission>,
    trust: Arc<TrustBundle>,
    limits: IngressLimits,
) -> OriginatingPeerLayer {
    OriginatingPeerLayer {
        shared: Arc::new(Shared {
            admission,
            trust,
            limits,
        }),
    }
}

#[derive(Clone)]
pub struct OriginatingPeerLayer {
    shared: Arc<Shared>,
}

impl<S> Layer<S> for OriginatingPeerLayer {
    type Service = OriginatingPeerService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        OriginatingPeerService {
            inner,
            shared: Arc::clone(&self.shared),
        }
    }
}

#[derive(Clone)]
pub struct OriginatingPeerService<S> {
    inner: S,
    shared: Arc<Shared>,
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

impl<S, B> Service<Request<B>> for OriginatingPeerService<S>
where
    S: Service<Request<B>, Response = Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = BoxFuture<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<B>) -> Self::Future {
        // Never trust a value that was already there; only this layer writes it.
        req.extensions_mut().remove::<OriginatingPeerExtension>();
        let decision = decide(&self.shared, &req);
        strip(&mut req);
        let mut inner = self.inner.clone();
        Box::pin(async move {
            match decision {
                Decision::Pass => inner.call(req).await,
                Decision::Attach(peer) => {
                    req.extensions_mut().insert(OriginatingPeerExtension(peer));
                    let mut response = inner.call(req).await?;
                    // RFC 9440 §2.4: a response selected by Client-Cert is not cacheable.
                    response
                        .headers_mut()
                        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                    Ok(response)
                }
                Decision::Refuse(transport, ingress) => Ok(refusal(&transport, ingress.as_ref())),
            }
        })
    }
}

enum Decision {
    Pass,
    Attach(Arc<VerifiedPeer>),
    Refuse(TransportError, Option<IngressError>),
}

fn decide<B>(shared: &Shared, req: &Request<B>) -> Decision {
    let Some(ListenerProvenance::Tls {
        listener_id,
        policy: TransportPolicy::TrustedIngress,
        ..
    }) = req.extensions().get::<ListenerProvenance>()
    else {
        return Decision::Pass;
    };
    let Some(PeerExtension(peer)) = req.extensions().get::<PeerExtension>() else {
        return Decision::Refuse(TransportError::IdentityMissing, None);
    };
    if !shared.admission.is_authorized_ingress(peer) {
        tracing::warn!(
            listener = %listener_id,
            thumbprint = peer.leaf_thumbprint_sha256(),
            "peer on the trusted-ingress listener is not a bound ingress"
        );
        return Decision::Refuse(TransportError::PeerNotBound, None);
    }
    if !has_client_cert_fields(req.headers()) {
        return Decision::Pass;
    }
    let chain = match parse_client_cert_fields(req.headers(), &shared.limits) {
        Ok(chain) => chain,
        Err(error) => {
            tracing::warn!(listener = %listener_id, code = error.code(), "forwarded evidence refused by parser");
            return Decision::Refuse(TransportError::ForwardedEvidenceUnverified, Some(error));
        }
    };
    match verify_originating(&chain, &shared.trust, peer, Utc::now(), listener_id) {
        Ok(originating) => Decision::Attach(Arc::new(originating)),
        Err(error) => {
            tracing::warn!(
                listener = %listener_id,
                code = error.code(),
                leaf = chain.leaf_thumbprint_sha256(),
                "forwarded evidence refused by verifier"
            );
            Decision::Refuse(error, None)
        }
    }
}

/// Removes every `Client-Cert` and `Client-Cert-Chain` field.
fn strip<B>(req: &mut Request<B>) {
    let headers = req.headers_mut();
    headers.remove(Field::ClientCert.header_name());
    headers.remove(Field::ClientCertChain.header_name());
}

fn refusal(transport: &TransportError, ingress: Option<&IngressError>) -> Response<Body> {
    let body = serde_json::json!({
        "error": transport.code(),
        "ingress_error": ingress.map(IngressError::code),
    })
    .to_string();
    let mut response = Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-opensesame-transport-error", transport.code());
    if let Some(code) = ingress.map(IngressError::code) {
        response = response.header("x-opensesame-ingress-error", code);
    }
    response
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(transport.code())))
}
