//! How a browser page reaches the plugin routes (ADR 0150 §7): through a
//! bearer it traded a one-time code for, bound to the exact origin named when
//! the code was printed (`opensesame plugins pair --origin <origin>`).
//!
//! ```text
//! POST   /v1/plugins/pairing  {"code":…}  Origin: <o> -> 201 {"id","origin","token"}
//!                                                      | 403 pairing_refused | 429
//! DELETE /v1/plugins/pairing  Bearer <token>, Origin: <o> -> 204 | 401
//! ```
//!
//! The bearer opens `GET /v1/plugins`, `PUT /v1/plugins/{id}` and
//! `GET /v1/plugins/{id}/notices` and nothing else: every other daemon route
//! still refuses any request that carries an `Origin`, and no other route
//! knows this bearer. A request from a browser is admitted here only when its
//! `Origin` is exactly the bound one; a request with no `Origin` still needs
//! the operator credential, as before.
//!
//! CORS on these routes answers only an origin that holds a bearer or a code
//! still waiting, echoes exactly that origin (never `*`), never allows
//! credentials, and always varies on `Origin`.

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_plugin_settings::{is_pairable_origin, unix_now, PairingError, PluginPairings};
use serde::Deserialize;
use serde_json::json;
use std::sync::PoisonError;

use crate::ratelimit::{rate_limited, RateKey};
use crate::{require_operator, App, UdsPeer};

const ALLOW_METHODS: &str = "GET, PUT, POST, DELETE";
const ALLOW_HEADERS: &str = "authorization, content-type";
const PREFLIGHT_MAX_AGE: &str = "600";
const PRIVATE_NETWORK_REQUEST: &str = "access-control-request-private-network";
const PRIVATE_NETWORK_ALLOW: &str = "access-control-allow-private-network";

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn origin_of(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN)?.to_str().ok()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn pairings(st: &App) -> Result<&PluginPairings, Response> {
    st.plugins.pairings.as_ref().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_settings_unavailable",
        )
    })
}

/// Admit a plugin-route caller: a browser holding the bearer paired to its
/// exact origin, or — with no `Origin` at all — the operator.
#[expect(
    clippy::result_large_err,
    reason = "axum::Response is intentionally the Err payload"
)]
pub(crate) fn require_plugin_caller(
    st: &App,
    headers: &HeaderMap,
    uds: &UdsPeer,
) -> Result<(), Response> {
    let Some(origin) = origin_of(headers) else {
        return require_operator(st, headers, uds);
    };
    let paired = bearer(headers)
        .zip(st.plugins.pairings.as_ref())
        .is_some_and(|(token, pairings)| pairings.authorizes(token, origin));
    if paired {
        Ok(())
    } else {
        Err(error(StatusCode::UNAUTHORIZED, "plugin_pairing_required"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Exchange {
    code: String,
}

/// Trade a one-time code for this origin's bearer. One refusal for every
/// way a code can be wrong, so a guesser learns nothing from which.
pub(crate) async fn exchange(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<Exchange>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return error(StatusCode::FORBIDDEN, "origin_required");
    };
    if let Err(retry_after) = st.plugins.pair_limiter.check(RateKey::PluginPairing) {
        return rate_limited(retry_after);
    }
    let store = match pairings(&st) {
        Ok(store) => store,
        Err(resp) => return resp,
    };
    let _guard = st
        .plugins
        .write
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match store.exchange(&body.code, origin, unix_now()) {
        Ok(issued) => (
            StatusCode::CREATED,
            Json(json!({ "id": issued.id, "origin": issued.origin, "token": issued.token })),
        )
            .into_response(),
        Err(PairingError::WrongOrigin) => {
            tracing::warn!(
                origin,
                "plugin pairing code presented from another origin; spent"
            );
            error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Unknown | PairingError::Expired | PairingError::InvalidOrigin) => {
            error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(PairingError::Full) => error(StatusCode::CONFLICT, "too_many_pairings"),
        Err(PairingError::Unreadable(_) | PairingError::Io(_)) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_pairings_unreadable",
        ),
    }
}

/// A page forgetting its pairing takes its own bearer with it.
pub(crate) async fn revoke(State(st): State<App>, headers: HeaderMap) -> Response {
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return error(StatusCode::UNAUTHORIZED, "plugin_pairing_required");
    };
    let store = match pairings(&st) {
        Ok(store) => store,
        Err(resp) => return resp,
    };
    let _guard = st
        .plugins
        .write
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match store.revoke(token, origin) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::UNAUTHORIZED, "plugin_pairing_required"),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_pairings_unreadable",
        ),
    }
}

fn admitted(st: &App, origin: &str) -> bool {
    st.plugins
        .pairings
        .as_ref()
        .is_some_and(|pairings| pairings.admits_origin(origin, unix_now()))
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

/// CORS for the plugin routes alone, answered from the pairings file.
pub(crate) async fn cors(State(st): State<App>, request: Request, next: Next) -> Response {
    let Some(origin) = origin_of(request.headers()).map(str::to_owned) else {
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

#[cfg(test)]
#[path = "plugin_pairing_tests.rs"]
mod tests;
