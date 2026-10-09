//! Loopback reverse proxy for the `/host` and `/identity` prefixes.

use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::proxy_path::{has_dot_segment, is_local_session_path};
use crate::{skip_hop_header, App};

const MAX_PROXY_BODY: usize = 2 * 1024 * 1024;

pub(crate) async fn proxy_loopback(st: &App, base: &str, prefix: &str, req: Request) -> Response {
    if !opensesame_host_core::daemon::base_url_is_local(base) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = req.uri().path();
    let rest = path.strip_prefix(prefix).unwrap_or(path);
    // Dot segments are refused on the raw request-target. The local-session
    // denylist is applied to the path reqwest will request: `url` rewrites a
    // raw `\` to `/` and collapses `.` and `..`, which the slash split misses.
    if has_dot_segment(rest) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{}{}{}", base.trim_end_matches('/'), rest, query);
    let Ok(parsed) = url::Url::parse(&url) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if prefix == "/host" && is_local_session_path(parsed.path()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if rest.as_bytes().contains(&b'\\') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let method = req.method().clone();
    let headers = req.headers().clone();
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_PROXY_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mut forward = st.http.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    for (name, value) in &headers {
        if skip_hop_header(name) || name == "x-opensesame-operator" {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            forward = forward.header(n, v);
        }
    }
    match forward.body(body.to_vec()).send().await {
        Ok(upstream) => {
            if upstream
                .content_length()
                .is_some_and(|len| len > MAX_PROXY_BODY as u64)
            {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response();
            }
            let status =
                StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut response = Response::builder().status(status);
            for (name, value) in upstream.headers() {
                let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_str().as_bytes()),
                    axum::http::HeaderValue::from_bytes(value.as_bytes()),
                ) else {
                    continue;
                };
                if !skip_hop_header(&name) {
                    response = response.header(name, value);
                }
            }
            let bytes = upstream.bytes().await.unwrap_or_else(|_| Bytes::new());
            if bytes.len() > MAX_PROXY_BODY {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response();
            }
            response
                .body(axum::body::Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "upstream_unreachable"})),
        )
            .into_response(),
    }
}
