//! One request, decided: admitted into invoke-through, tunnelled on to a
//! passthrough host, or refused.
//!
//! The order is fixed. The request's destinations must agree; its body is
//! read up to invoke-through's request cap (the fence's 256 KiB) before
//! anything else looks at it, so the scan below sees every byte that could be
//! forwarded; then [`SurrogateLedger::admit`] decides. An admitted request
//! becomes an [`InvokeRequest`] (only the provider's forwardable headers
//! survive), clears the invoker's own pre-connect fence, and only then is a
//! credential acquired — on a blocking thread, since sources run tools — and
//! placed by [`Invoker::execute`], which scrubs whatever comes back. A refused
//! request goes to the embedder's [`RefusalSink`](crate::RefusalSink) and the
//! client gets the one refusal message.
//!
//! [`SurrogateLedger::admit`]: opensesame_invoke_through::SurrogateLedger::admit
//! [`InvokeRequest`]: opensesame_invoke_through::InvokeRequest
//! [`Invoker::execute`]: opensesame_invoke_through::Invoker::execute

use bytes::Bytes;
use http::StatusCode;
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper::http::request::Parts;
use hyper::{Request, Response};
use opensesame_invoke_through::{Admission, InvokeError, RequestView, DEFAULT_REQUEST_BODY_CAP};

use crate::listener::RunContext;
use crate::respond::{self, ProxyBody};
use crate::target::Target;

const HTTPS_PORT: u16 = 443;
const HTTP_PORT: u16 = 80;

/// A request that arrived inside a terminated CONNECT tunnel.
pub(crate) async fn handle_tunnelled(
    ctx: &RunContext,
    target: &Target,
    req: Request<Incoming>,
) -> Response<ProxyBody> {
    let (parts, body) = req.into_parts();
    if !target.request_agrees(&parts) {
        return respond::refused(StatusCode::FORBIDDEN);
    }
    let body = match read_capped(body).await {
        Ok(body) => body,
        Err(status) => return respond::refused(status),
    };
    let (headers, exact) = header_pairs(&parts.headers);
    let path_and_query = path_and_query(&parts);
    let view = RequestView {
        method: parts.method.as_str(),
        scheme: "https",
        host: &target.host,
        port: target.view_port(HTTPS_PORT),
        path_and_query,
        headers: &headers,
        body: &body,
    };
    match ctx.shared.admit(&view, &ctx.caller) {
        Err(refusal) => {
            ctx.report(&refusal);
            respond::refused(StatusCode::FORBIDDEN)
        }
        Ok(Some(_)) if !exact => respond::refused(StatusCode::BAD_REQUEST),
        Ok(Some(admission)) => broker(ctx, &admission, &view).await,
        Ok(None) if ctx.is_passthrough(target) => {
            let authority = target.authority();
            let passthrough = &ctx.shared.config.passthrough;
            passthrough
                .forward(
                    &parts.method,
                    &authority,
                    path_and_query,
                    &parts.headers,
                    body.clone(),
                )
                .await
        }
        Ok(None) => respond::refused(StatusCode::FORBIDDEN),
    }
}

/// A plain-HTTP request in absolute form. Scanned, so a surrogate in it is
/// reported, and refused whatever it carried: there is no plaintext egress.
pub(crate) async fn handle_plain(ctx: &RunContext, req: Request<Incoming>) -> Response<ProxyBody> {
    let (parts, body) = req.into_parts();
    let Some(target) = Target::parse_absolute_http(&parts.uri) else {
        return respond::refused(StatusCode::BAD_REQUEST);
    };
    let body = match read_capped(body).await {
        Ok(body) => body,
        Err(status) => return respond::refused(status),
    };
    let (headers, _) = header_pairs(&parts.headers);
    let view = RequestView {
        method: parts.method.as_str(),
        scheme: "http",
        host: &target.host,
        port: target.view_port(HTTP_PORT),
        path_and_query: path_and_query(&parts),
        headers: &headers,
        body: &body,
    };
    if let Err(refusal) = ctx.shared.admit(&view, &ctx.caller) {
        ctx.report(&refusal);
    }
    respond::refused(StatusCode::FORBIDDEN)
}

async fn broker(
    ctx: &RunContext,
    admission: &Admission,
    view: &RequestView<'_>,
) -> Response<ProxyBody> {
    let config = &ctx.shared.config;
    let prepared = match config.invoker.preflight(admission.invoke_request(view)) {
        Ok(prepared) => prepared,
        Err(InvokeError::RequestBodyTooLarge { .. }) => {
            return respond::refused(StatusCode::PAYLOAD_TOO_LARGE)
        }
        Err(_) => return respond::refused(StatusCode::FORBIDDEN),
    };
    let Some(source) = config.sources.source_for(admission) else {
        return respond::upstream_failed(StatusCode::BAD_GATEWAY);
    };
    let Ok(Ok(token)) = tokio::task::spawn_blocking(move || source.acquire()).await else {
        return respond::upstream_failed(StatusCode::BAD_GATEWAY);
    };
    match config.invoker.execute(&token, prepared).await {
        Ok(invoked) => {
            if let Some(receipts) = &config.receipts {
                receipts.brokered(admission, &invoked.receipt);
            }
            respond::brokered(invoked)
        }
        Err(InvokeError::Timeout) => respond::upstream_failed(StatusCode::GATEWAY_TIMEOUT),
        Err(_) => respond::upstream_failed(StatusCode::BAD_GATEWAY),
    }
}

/// The body, whole, or the status that refuses it: `413` past the cap,
/// `400` for a body that failed mid-read.
async fn read_capped(body: Incoming) -> Result<Bytes, StatusCode> {
    match Limited::new(body, DEFAULT_REQUEST_BODY_CAP).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(error) if error.is::<http_body_util::LengthLimitError>() => {
            Err(StatusCode::PAYLOAD_TOO_LARGE)
        }
        Err(_) => Err(StatusCode::BAD_REQUEST),
    }
}

/// Every header, for the scan, and whether each was UTF-8. A value that is
/// not is read lossily so a surrogate beside a stray byte is still seen; a
/// request carrying one is never brokered, so the lossy copy never travels.
fn header_pairs(headers: &HeaderMap) -> (Vec<(String, String)>, bool) {
    let mut exact = true;
    let pairs = headers
        .iter()
        .map(|(name, value)| {
            exact &= std::str::from_utf8(value.as_bytes()).is_ok();
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    (pairs, exact)
}

fn path_and_query(parts: &Parts) -> &str {
    parts.uri.path_and_query().map_or("/", |p| p.as_str())
}
