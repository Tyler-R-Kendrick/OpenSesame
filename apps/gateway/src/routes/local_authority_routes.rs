//! Local-authority registrations; the parent router supplies the shared guards.
use super::{
    agent_capabilities, browser_pairings, device, host_authorizations, secret_config_policy,
    session,
};
use crate::app_state::AppState;
use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .merge(browser_pairings::routes())
        .merge(host_authorizations::routes())
        .route(
            "/api/v1/agent-launches",
            post(agent_capabilities::create).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/api/v1/agent-launches/token",
            post(agent_capabilities::token).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/v1/agent-clients/{id}",
            delete(agent_capabilities::revoke).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/v1/device/authorize", post(device::authorize))
        .route("/api/v1/device/token", post(device::token))
        .route("/api/v1/device/approve", post(device::approve))
        .route("/api/v1/session", get(session::status))
        .route("/api/v1/session/local", post(session::local_mint))
        .route("/api/v1/sessions/revoke", post(session::revoke))
        .route("/api/v1/whoami", get(session::whoami))
        .route(
            "/api/v1/organizations/{organization}/config-members/{principal}",
            get(secret_config_policy::get_role)
                .put(secret_config_policy::set_role)
                .layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v1/projects/{project}/config-access",
            get(secret_config_policy::get_project),
        )
        .route(
            "/api/v1/projects/{project}/config-access/{principal}",
            put(secret_config_policy::set_project).layer(DefaultBodyLimit::max(4 * 1024)),
        )
}
