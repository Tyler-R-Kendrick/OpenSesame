mod aauth;
mod admin;
mod agents;
mod connections;
mod credential_connections;
mod device;
mod health;
mod intents;
mod protected_resource;
mod receipts;
mod session;
mod sync;
mod tasks;

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::app_state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
        .route("/health/authority", get(health::authority))
        .route("/health/degraded", get(health::degraded))
        .route("/health/providers", get(health::providers))
        .route("/api/v1/health", get(health::live))
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
        .route("/api/v1/sessions/revoke", post(session::revoke))
        .route("/api/v1/whoami", get(session::whoami))
        .route("/api/v1/providers", get(connections::list_providers))
        .route(
            "/api/v1/credential-providers",
            get(credential_connections::catalog),
        )
        .route(
            "/api/v1/credential-providers/{id}/test",
            post(credential_connections::test_provider),
        )
        .route(
            "/api/v1/credential-connections",
            get(credential_connections::list).post(credential_connections::create),
        )
        .route(
            "/api/v1/credential-connections/{id}",
            put(credential_connections::update).delete(credential_connections::delete),
        )
        .route(
            "/api/v1/integrations",
            get(connections::list_integrations)
                .post(connections::create_integration)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/integrations/{id}",
            get(connections::get_integration)
                .patch(connections::update_integration)
                .delete(connections::delete_integration)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections",
            get(connections::list)
                .post(connections::create)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections/{id}",
            get(connections::get).delete(connections::delete),
        )
        .route(
            "/api/v1/connections/{id}/authorize",
            post(connections::start_authorization).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections/{id}/refresh",
            post(connections::refresh).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections/{id}/credential",
            post(connections::set_credential).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections/{id}/bindings",
            post(connections::create_binding).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/connections/{id}/bindings/{binding_id}",
            delete(connections::delete_binding),
        )
        .route("/api/v1/connections/{id}/events", get(connections::events))
        .route(
            "/api/v1/oauth/callback/{provider_id}",
            get(connections::oauth_callback),
        )
        .route("/api/v1/intents", post(intents::create))
        .route("/api/v1/receipts/keys", get(receipts::keys))
        .route("/api/v1/receipts/{id}", get(receipts::get))
        .route("/api/v1/receipts/{id}/verify", post(receipts::verify))
        .route("/api/v1/agent-identities", post(agents::create_identity))
        .route("/api/v1/agent-claims/{id}/poll", post(agents::poll))
        .route("/api/v1/agent-claims/{id}/complete", post(agents::complete))
        .route("/api/v1/admin/authority", post(admin::set_authority))
        .route("/api/v1/sync/push", post(sync::push))
        .route("/api/v1/sync/pull", post(sync::pull))
        .route(
            "/api/v1/tasks",
            get(tasks::list_tasks).post(tasks::start_task),
        )
        .route("/api/v1/tasks/intents", post(tasks::freeze_intent))
        .route("/api/v1/tasks/invoke", post(tasks::invoke_task))
        .route("/api/v1/tasks/{id}", get(tasks::get_task))
        .route("/api/v1/tasks/{id}/terminate", post(tasks::terminate_task))
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
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}
