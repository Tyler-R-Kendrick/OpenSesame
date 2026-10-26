//! The daemon's HTTP route table and its health/loopback handlers, split
//! out of `lib.rs` for the module-size budget (ADR 0093).

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    response::Response,
    routing::{any, get, post},
    Json, Router,
};
use serde_json::{json, Value};

use super::duress_routes::{duress_peer_envelope, duress_peer_health};
use super::proxy_loopback::proxy_loopback;
use super::{
    agent_capability, approve_claim, approve_device, cli_app_integration, discover, fill,
    get_access_token, introspect_capability, invoke_through, list_sessions, mint, mint_capability,
    operator_invoke_l1, plugin_routes, promote, revoke, tailnet_admin_routes, toolbar,
    vault_drive_routes, App,
};

pub(super) async fn daemon_health() -> Json<Value> {
    Json(json!({"status":"ok"}))
}

async fn proxy_host(State(st): State<App>, req: Request) -> Response {
    let base = st.host_api.clone();
    proxy_loopback(&st, &base, "/host", req).await
}

async fn proxy_identity(State(st): State<App>, req: Request) -> Response {
    let base = st.identity_api.clone();
    proxy_loopback(&st, &base, "/identity", req).await
}

pub(super) fn router(state: App) -> Router {
    Router::new()
        .route("/health", get(daemon_health))
        .route("/health/live", get(daemon_health))
        .route("/v1/list_sessions", post(list_sessions))
        .route(
            "/v1/agent-capabilities/token",
            post(agent_capability::exchange).layer(DefaultBodyLimit::max(2048)),
        )
        .route("/v1/get_access_token", post(get_access_token))
        .route("/v1/mint_capability", post(mint_capability))
        .route("/v1/introspect_capability", post(introspect_capability))
        .route("/v1/revoke", post(revoke))
        .route("/v1/discover", post(discover))
        .route(
            "/v1/promote",
            post(promote::promote).layer(DefaultBodyLimit::max(promote::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/invoke_through",
            post(invoke_through::invoke_through)
                .layer(DefaultBodyLimit::max(invoke_through::MAX_BODY_BYTES)),
        )
        .route(
            "/v1/mint",
            post(mint::mint_via_daemon).layer(DefaultBodyLimit::max(mint::MAX_BODY_BYTES)),
        )
        .merge(cli_app_integration::routes(&state))
        .route("/v1/toolbar/status", get(toolbar::toolbar_status))
        .route("/v1/toolbar/approve_device", post(approve_device))
        .route("/v1/toolbar/approve_claim", post(approve_claim))
        .route("/v1/operator/invoke_l1", post(operator_invoke_l1))
        .route("/host", any(proxy_host))
        .route("/host/{*path}", any(proxy_host))
        .route("/identity", any(proxy_identity))
        .route("/identity/{*path}", any(proxy_identity))
        .route("/v1/duress/peer/health", get(duress_peer_health))
        .route("/v1/duress/peer/envelope", post(duress_peer_envelope))
        .merge(vault_drive_routes::routes())
        .merge(plugin_routes::routes(&state))
        .merge(tailnet_admin_routes::routes(&state))
        .merge(fill::routes(fill::FillState::from_env(), &state))
        .with_state(state)
}
