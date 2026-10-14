use axum::{
    extract::State,
    http::{header, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::App;

use super::auth::origin_of;

const ALLOW_METHODS: &str = "GET, POST, DELETE";
const ALLOW_HEADERS: &str = "authorization, content-type";
const PREFLIGHT_MAX_AGE: &str = "600";

fn allow(response: &mut Response, origin: Option<&str>) {
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(value) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
}

pub(super) async fn cors(
    State(st): State<App>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(origin) = origin_of(request.headers()).map(str::to_owned) else {
        return next.run(request).await;
    };
    let admitted = st
        .cli_app_integration
        .lock()
        .map(|host| {
            host.pairings
                .admits_origin(&origin, chrono::Utc::now().timestamp() as u64)
        })
        .unwrap_or(false)
        .then_some(origin);
    if request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let status = if admitted.is_some() {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::FORBIDDEN
        };
        let mut response = status.into_response();
        allow(&mut response, admitted.as_deref());
        if admitted.is_some() {
            let headers = response.headers_mut();
            for (name, value) in [
                (header::ACCESS_CONTROL_ALLOW_METHODS, ALLOW_METHODS),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, ALLOW_HEADERS),
                (header::ACCESS_CONTROL_MAX_AGE, PREFLIGHT_MAX_AGE),
            ] {
                headers.insert(name, HeaderValue::from_static(value));
            }
        }
        return response;
    }
    let mut response = next.run(request).await;
    allow(&mut response, admitted.as_deref());
    response
}
