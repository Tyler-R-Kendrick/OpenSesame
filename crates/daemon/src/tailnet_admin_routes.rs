//! HTTP face of tailnet device management (ADR 0169).
//!
//! ```text
//! POST   /v1/tailnet/pairing                 {"code"}  Origin -> 201 {id,origin,role,label,token}
//! DELETE /v1/tailnet/pairing                 Bearer, Origin   -> 204 | 401
//! GET    /v1/tailnet/status                  read
//! GET    /v1/tailnet/devices[/{id}]          read
//! POST   /v1/tailnet/devices/{id}/authorized {"authorized"}      manage
//! POST   /v1/tailnet/devices/{id}/name       {"name"}            manage
//! POST   /v1/tailnet/devices/{id}/tags       {"tags"}            manage
//! POST   /v1/tailnet/devices/{id}/key-expiry {"disabled"}        manage
//! POST   /v1/tailnet/devices/{id}/expire                         manage
//! POST   /v1/tailnet/devices/{id}/routes     {"enabled_routes"}  manage
//! DELETE /v1/tailnet/devices/{id}                                manage
//! GET    /v1/tailnet/keys  POST /v1/tailnet/keys  DELETE /v1/tailnet/keys/{id}
//! GET    /v1/tailnet/audit                   read
//! ```
//!
//! Every route but the exchange takes a bearer a page traded a pairing code
//! for, from the exact origin it was paired at, holding the role the route
//! needs. Nothing else opens them: there is no operator path, because the
//! operator configures this from a terminal (`opensesame tailnet`) and never
//! needs a browser's route. Every change that reached Tailscale is written to
//! the audit trail; a request that failed validation changed nothing and is
//! not.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use opensesame_plugin_settings::{is_pairable_origin, unix_now};
use opensesame_tailnet_admin::{ops, AdminError, AdminStore, AuditEntry, Paired, Role, Upstream};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ratelimit::{rate_limited, RateKey, TokenBucket};
use crate::App;

#[path = "tailnet_admin_cors.rs"]
mod cors;

/// The JSON a route reads is small; a tag list is the largest.
const MAX_BODY: usize = 16 * 1024;

/// Where the tailnet admin state is, how Tailscale is reached, and the
/// budgets that bound a pairing exchange and a bearer's changes.
#[derive(Clone)]
pub(crate) struct TailnetAdminHost {
    pub(crate) store: Option<AdminStore>,
    pub(crate) upstream: Arc<Upstream>,
    /// One pairing-file writer at a time.
    pub(crate) write: Arc<Mutex<()>>,
    /// Pairing exchanges: five at once, then one every twelve seconds.
    pub(crate) pair_limiter: Arc<TokenBucket>,
    /// Changes per pairing: twenty at once, then two a second.
    pub(crate) change_limiter: Arc<TokenBucket>,
}

impl TailnetAdminHost {
    pub(crate) fn from_process() -> Self {
        Self::at(
            opensesame_tailnet_admin::default_admin_dir()
                .ok()
                .map(AdminStore::at),
            Upstream::from_env(),
        )
    }

    /// No state directory: every route refuses (tests that do not use it).
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        Self::at(None, Upstream::production())
    }

    pub(crate) fn at(store: Option<AdminStore>, upstream: Upstream) -> Self {
        Self {
            store,
            upstream: Arc::new(upstream),
            write: Arc::new(Mutex::new(())),
            pair_limiter: Arc::new(TokenBucket::new(5.0, 1.0 / 12.0)),
            change_limiter: Arc::new(TokenBucket::new(20.0, 2.0)),
        }
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn refused(err: &AdminError) -> Response {
    let status = StatusCode::from_u16(err.status()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut body = json!({ "error": err.code() });
    if let Some(detail) = err.detail() {
        body["detail"] = detail.into();
    }
    if let AdminError::RateLimited { retry_after } = err {
        body["retry_after"] = (*retry_after).into();
        let mut response = (status, Json(body)).into_response();
        if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }
    if let AdminError::Storage(io) = err {
        tracing::warn!(error = %io, "tailnet admin storage failed");
    }
    (status, Json(body)).into_response()
}

fn store(st: &App) -> Result<&AdminStore, Response> {
    st.tailnet
        .store
        .as_ref()
        .ok_or_else(|| refused(&AdminError::NoDirectory))
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

/// The pairing a request speaks for, if it holds `needed`.
#[expect(
    clippy::result_large_err,
    reason = "axum::Response is intentionally the Err payload"
)]
fn caller(st: &App, headers: &HeaderMap, needed: Role) -> Result<Paired, Response> {
    let store = store(st)?;
    let paired = origin_of(headers)
        .zip(bearer(headers))
        .and_then(|(origin, token)| store.pairings().authorize(token, origin))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "tailnet_pairing_required"))?;
    if paired.role.allows(needed) {
        Ok(paired)
    } else {
        Err(error(StatusCode::FORBIDDEN, "role_forbidden"))
    }
}

/// What a successful operation answers with.
enum Reply {
    Empty,
    Json(StatusCode, Value),
}

/// A read: resolve the caller, run it, answer.
async fn read<F, Fut>(st: App, headers: HeaderMap, run: F) -> Response
where
    F: FnOnce(Arc<Upstream>, AdminStore) -> Fut,
    Fut: Future<Output = Result<Value, AdminError>>,
{
    if let Err(resp) = caller(&st, &headers, Role::Read) {
        return resp;
    }
    let Ok(store) = store(&st).cloned() else {
        return refused(&AdminError::NoDirectory);
    };
    match run(Arc::clone(&st.tailnet.upstream), store).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => refused(&err),
    }
}

/// A change: resolve a `manage` caller, spend its budget, run it, write the
/// audit line, answer.
async fn change<F, Fut>(st: App, headers: HeaderMap, action: &str, target: &str, run: F) -> Response
where
    F: FnOnce(Arc<Upstream>, AdminStore) -> Fut,
    Fut: Future<Output = Result<(Reply, Option<String>), AdminError>>,
{
    let paired = match caller(&st, &headers, Role::Manage) {
        Ok(paired) => paired,
        Err(resp) => return resp,
    };
    if let Err(retry_after) = st
        .tailnet
        .change_limiter
        .check(RateKey::TailnetChange(paired.id.clone()))
    {
        return rate_limited(retry_after);
    }
    let Ok(store) = store(&st).cloned() else {
        return refused(&AdminError::NoDirectory);
    };
    let outcome = run(Arc::clone(&st.tailnet.upstream), store.clone()).await;
    let (status, response, named) = match outcome {
        Ok((Reply::Empty, named)) => (204, StatusCode::NO_CONTENT.into_response(), named),
        Ok((Reply::Json(status, value), named)) => (
            status.as_u16(),
            (status, Json(value)).into_response(),
            named,
        ),
        Err(err @ (AdminError::Invalid(_) | AdminError::TagsRequired)) => return refused(&err),
        Err(err) => (err.status(), refused(&err), None),
    };
    let target = named.unwrap_or_else(|| target.to_string());
    let entry = AuditEntry::new(unix_now(), &paired, action, &target, status);
    if let Err(err) = store.audit().append(&entry) {
        tracing::warn!(error = %err, action, "tailnet audit line not written");
    }
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Exchange {
    code: String,
}

async fn exchange(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<Exchange>,
) -> Response {
    let Some(origin) = origin_of(&headers).filter(|o| is_pairable_origin(o)) else {
        return error(StatusCode::FORBIDDEN, "origin_required");
    };
    if let Err(retry_after) = st.tailnet.pair_limiter.check(RateKey::TailnetPairing) {
        return rate_limited(retry_after);
    }
    let store = match store(&st) {
        Ok(store) => store,
        Err(resp) => return resp,
    };
    let _guard = st
        .tailnet
        .write
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match store.pairings().exchange(&body.code, origin, unix_now()) {
        Ok((paired, token)) => (
            StatusCode::CREATED,
            Json(json!({
                "id": paired.id,
                "origin": paired.origin,
                "role": paired.role,
                "label": paired.label,
                "token": token,
            })),
        )
            .into_response(),
        Err(AdminError::PairingRefused) => {
            tracing::warn!(origin, "tailnet pairing code refused; spent if it existed");
            error(StatusCode::FORBIDDEN, "pairing_refused")
        }
        Err(err) => refused(&err),
    }
}

async fn forget(State(st): State<App>, headers: HeaderMap) -> Response {
    let (Some(origin), Some(token)) = (origin_of(&headers), bearer(&headers)) else {
        return error(StatusCode::UNAUTHORIZED, "tailnet_pairing_required");
    };
    let store = match store(&st) {
        Ok(store) => store,
        Err(resp) => return resp,
    };
    let _guard = st
        .tailnet
        .write
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match store.pairings().revoke(token, origin) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::UNAUTHORIZED, "tailnet_pairing_required"),
        Err(err) => refused(&err),
    }
}

async fn status(State(st): State<App>, headers: HeaderMap) -> Response {
    let paired = match caller(&st, &headers, Role::Read) {
        Ok(paired) => paired,
        Err(resp) => return resp,
    };
    let Ok(store) = store(&st) else {
        return refused(&AdminError::NoDirectory);
    };
    match ops::status(store) {
        Ok(mut value) => {
            value["role"] = paired.role.as_str().into();
            value["label"] = paired.label.into();
            Json(value).into_response()
        }
        Err(err) => refused(&err),
    }
}

async fn devices(State(st): State<App>, headers: HeaderMap) -> Response {
    read(st, headers, |up, store| async move {
        Ok(json!({ "devices": ops::list_devices(&up, &store).await? }))
    })
    .await
}

async fn device(State(st): State<App>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    read(st, headers, |up, store| async move {
        Ok(serde_json::to_value(ops::get_device(&up, &store, &id).await?).unwrap_or_default())
    })
    .await
}

async fn keys(State(st): State<App>, headers: HeaderMap) -> Response {
    read(st, headers, |up, store| async move {
        Ok(json!({ "keys": ops::list_keys(&up, &store).await? }))
    })
    .await
}

#[derive(Deserialize)]
struct AuditQuery {
    #[serde(default)]
    limit: Option<usize>,
}

async fn audit(
    State(st): State<App>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Response {
    read(st, headers, |_, store| async move {
        let limit = query.limit.unwrap_or(opensesame_tailnet_admin::AUDIT_READ);
        Ok(json!({ "entries": store.audit().recent(limit)? }))
    })
    .await
}

#[path = "tailnet_admin_changes.rs"]
mod changes;

pub(crate) fn routes(app: &App) -> Router<App> {
    Router::new()
        .route(
            "/v1/tailnet/pairing",
            post(exchange)
                .delete(forget)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route("/v1/tailnet/status", get(status))
        .route("/v1/tailnet/devices", get(devices))
        .route(
            "/v1/tailnet/devices/{id}",
            get(device).delete(changes::delete_device),
        )
        .route(
            "/v1/tailnet/devices/{id}/authorized",
            post(changes::authorized),
        )
        .route("/v1/tailnet/devices/{id}/name", post(changes::rename))
        .route("/v1/tailnet/devices/{id}/tags", post(changes::tags))
        .route(
            "/v1/tailnet/devices/{id}/key-expiry",
            post(changes::key_expiry),
        )
        .route("/v1/tailnet/devices/{id}/expire", post(changes::expire))
        .route("/v1/tailnet/devices/{id}/routes", post(changes::routes))
        .route("/v1/tailnet/keys", get(keys).post(changes::create_key))
        .route(
            "/v1/tailnet/keys/{id}",
            axum::routing::delete(changes::delete_key),
        )
        .route("/v1/tailnet/audit", get(audit))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            cors::cors,
        ))
}

#[cfg(test)]
#[path = "tailnet_admin_routes_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "tailnet_admin_conformance_tests.rs"]
mod conformance;
