//! One CONNECT tunnel: terminate TLS as the host the client asked for, then
//! serve the HTTP/1.1 requests inside it.
//!
//! The client hello is read before any certificate is chosen, and its server
//! name must agree with the CONNECT authority; a disagreement closes the
//! connection before a leaf is minted. A client that rejects the run's leaf —
//! a certificate-pinning SDK, a client that ignored the trust variables —
//! fails its handshake here and the connection closes. There is no fallback:
//! no blind tunnel, no retry with a credential, nothing reaches an upstream
//! (ADR 0150 §6.1).

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade::OnUpgrade;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio_rustls::LazyConfigAcceptor;

use crate::broker;
use crate::listener::{RunContext, HEADER_TIMEOUT};
use crate::respond::ProxyBody;
use crate::target::Target;

/// How long a client may take over each half of the TLS handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Run the tunnel until it closes or the run ends.
pub(crate) async fn run(ctx: Arc<RunContext>, upgrade: OnUpgrade, target: Target) {
    let watch = Arc::clone(&ctx);
    tokio::select! {
        () = terminate(ctx, upgrade, target) => {}
        () = watch.ended() => {}
    }
}

async fn terminate(ctx: Arc<RunContext>, upgrade: OnUpgrade, target: Target) {
    let Ok(upgraded) = upgrade.await else {
        return;
    };
    let acceptor =
        LazyConfigAcceptor::new(rustls::server::Acceptor::default(), TokioIo::new(upgraded));
    let Ok(Ok(start)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor).await else {
        return;
    };
    if !target.sni_agrees(start.client_hello().server_name()) {
        return;
    }
    let Ok(config) = ctx.ca.server_config(&target.host) else {
        return;
    };
    let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, start.into_stream(config)).await
    else {
        return;
    };
    let target = Arc::new(target);
    let service = service_fn(move |req| inner(Arc::clone(&ctx), Arc::clone(&target), req));
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(TokioIo::new(tls), service)
        .await;
}

async fn inner(
    ctx: Arc<RunContext>,
    target: Arc<Target>,
    req: Request<Incoming>,
) -> Result<Response<ProxyBody>, Infallible> {
    Ok(broker::handle_tunnelled(&ctx, &target, req).await)
}
