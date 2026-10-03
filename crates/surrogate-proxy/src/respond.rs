//! Every response the proxy writes itself.
//!
//! A refusal says one thing whatever the reason
//! ([`Refusal::CLIENT_MESSAGE`]): a process probing with guesses learns
//! nothing about which fence it hit, or whether a surrogate it tried was
//! real. Nothing here ever echoes a request, a header or a surrogate.

use bytes::Bytes;
use http::StatusCode;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::Response;
use opensesame_invoke_through::{InvokeResponse, Refusal};

/// The body every proxy response carries: a buffered one the proxy built, or
/// a passthrough upstream's stream.
pub(crate) type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// Realm named in a `407`: the proxy's own, never a host's.
const REALM: &str = "Basic realm=\"opensesame-surrogate-proxy\"";
/// What a client is told when an admitted call failed upstream.
const UPSTREAM_MESSAGE: &str = "the credential broker could not complete the call";

pub(crate) fn full(body: impl Into<Bytes>) -> ProxyBody {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

fn text(status: StatusCode, message: &'static str) -> Response<ProxyBody> {
    let mut response = Response::new(full(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

/// A refusal: the one client message, at `status`.
pub(crate) fn refused(status: StatusCode) -> Response<ProxyBody> {
    text(status, Refusal::CLIENT_MESSAGE)
}

/// `407`: no or the wrong proxy credential.
pub(crate) fn proxy_auth_required() -> Response<ProxyBody> {
    let mut response = refused(StatusCode::PROXY_AUTHENTICATION_REQUIRED);
    response.headers_mut().insert(
        http::header::PROXY_AUTHENTICATE,
        http::HeaderValue::from_static(REALM),
    );
    response
}

/// An admitted call that did not complete. The status says which class
/// (`502`, `504`, `413`), the body says nothing more.
pub(crate) fn upstream_failed(status: StatusCode) -> Response<ProxyBody> {
    text(status, UPSTREAM_MESSAGE)
}

/// `200` for a CONNECT the proxy will terminate.
pub(crate) fn tunnel_established() -> Response<ProxyBody> {
    Response::new(full(Bytes::new()))
}

/// The brokered response as invoke-through returned it: status, allowlisted
/// and already-scrubbed headers, scrubbed body.
pub(crate) fn brokered(invoked: InvokeResponse) -> Response<ProxyBody> {
    let status = StatusCode::from_u16(invoked.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::new(full(invoked.body));
    *response.status_mut() = status;
    for (name, value) in invoked.headers {
        if let (Ok(name), Ok(value)) = (
            http::HeaderName::from_bytes(name.as_bytes()),
            http::HeaderValue::from_str(&value),
        ) {
            response.headers_mut().append(name, value);
        }
    }
    response
}
