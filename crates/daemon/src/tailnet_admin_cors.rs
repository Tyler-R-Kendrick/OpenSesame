//! CORS for the tailnet routes alone (ADR 0169 §4), answered from the
//! pairings file as the plugin routes' is: only an origin that holds a bearer
//! or a code still waiting is echoed, exactly (never `*`), credentials are
//! never allowed, and every answer varies on `Origin`.

use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use opensesame_plugin_settings::unix_now;

use crate::App;

const ALLOW_METHODS: &str = "GET, POST, DELETE";
const ALLOW_HEADERS: &str = "authorization, content-type";
const PREFLIGHT_MAX_AGE: &str = "600";
const PRIVATE_NETWORK_REQUEST: &str = "access-control-request-private-network";
const PRIVATE_NETWORK_ALLOW: &str = "access-control-allow-private-network";

fn admitted(st: &App, origin: &str) -> bool {
    st.tailnet
        .store
        .as_ref()
        .is_some_and(|store| store.pairings().admits_origin(origin, unix_now()))
}

fn allow(response: &mut Response, origin: Option<&str>) {
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(value) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
}

fn preflight(origin: Option<&str>, private_network: bool) -> Response {
    let status = if origin.is_some() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::FORBIDDEN
    };
    let mut response = status.into_response();
    allow(&mut response, origin);
    if origin.is_some() {
        let headers = response.headers_mut();
        for (name, value) in [
            (header::ACCESS_CONTROL_ALLOW_METHODS, ALLOW_METHODS),
            (header::ACCESS_CONTROL_ALLOW_HEADERS, ALLOW_HEADERS),
            (header::ACCESS_CONTROL_MAX_AGE, PREFLIGHT_MAX_AGE),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        if private_network {
            headers.insert(PRIVATE_NETWORK_ALLOW, HeaderValue::from_static("true"));
        }
    }
    response
}

pub(super) async fn cors(State(st): State<App>, request: Request, next: Next) -> Response {
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
    else {
        return next.run(request).await;
    };
    let origin = admitted(&st, &origin).then_some(origin);
    let headers = request.headers();
    if request.method() == Method::OPTIONS
        && headers.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let private = headers
            .get(PRIVATE_NETWORK_REQUEST)
            .is_some_and(|value| value == "true");
        return preflight(origin.as_deref(), private);
    }
    let mut response = next.run(request).await;
    allow(&mut response, origin.as_deref());
    response
}
