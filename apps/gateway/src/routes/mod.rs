mod aauth;
mod admin;
mod agents;
mod device;
mod health;
mod intents;
mod protected_resource;
mod receipts;
mod session;
mod sync;
mod tasks;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::app_state::AppState;

pub fn router(state: AppState) -> Router {
    let task_routes = Router::new()
        .route("/", get(tasks::list_tasks).post(tasks::start_task))
        .route("/{id}", get(tasks::get_task))
        .route("/{id}/terminate", post(tasks::terminate_task))
        .route("/intents", post(tasks::freeze_intent))
        .with_state(tasks::new_task_engine());

    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
        .route("/health/authority", get(health::authority))
        .route("/health/degraded", get(health::degraded))
        .route("/health/providers", get(health::providers))
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource::metadata),
        )
        .route("/auth.md", get(protected_resource::auth_md))
        .route(
            "/.well-known/agent-card.json",
            get(protected_resource::agent_card),
        )
        .route("/api/v1/device/authorize", post(device::authorize))
        .route("/api/v1/device/token", post(device::token))
        .route("/api/v1/device/approve", post(device::approve))
        .route("/api/v1/session", get(session::status))
        .route("/api/v1/whoami", get(session::whoami))
        .route("/api/v1/connections", get(session::list_connections))
        .route("/api/v1/intents", post(intents::create))
        .route("/api/v1/receipts/{id}", get(receipts::get))
        .route("/api/v1/receipts/{id}/verify", post(receipts::verify))
        .route("/api/v1/agent-identities", post(agents::create_identity))
        .route("/api/v1/agent-claims/{id}/poll", post(agents::poll))
        .route("/api/v1/agent-claims/{id}/complete", post(agents::complete))
        .route("/api/v1/admin/authority", post(admin::set_authority))
        .route("/api/v1/sync/push", post(sync::push))
        .route("/api/v1/sync/pull", post(sync::pull))
        .nest("/api/v1/tasks", task_routes)
        .route("/experimental/aauth/v1/status", get(aauth::status))
        .route(
            "/experimental/aauth/v1/map/person",
            post(aauth::map_person_handler),
        )
        .route(
            "/experimental/aauth/v1/map/agent",
            post(aauth::map_agent_handler),
        )
        .route(
            "/experimental/aauth/v1/mission/digest",
            post(aauth::mission_digest),
        )
        .route(
            "/experimental/aauth/v1/scope/check",
            post(aauth::scope_check),
        )
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}
