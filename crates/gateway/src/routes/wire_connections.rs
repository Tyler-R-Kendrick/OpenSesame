//! Connection, integration, credential, attachment and backup route wiring.
//! Split out of [`super::router`] for the 400-line module budget
//! (ADR 0093); every route and body limit is unchanged.

use crate::app_state::AppState;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post, put};
use axum::Router;

use super::{attachments, backup, connections, credential_connections};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/attachments/replicate/manifest",
            post(attachments::replicate_manifest)
                .layer(DefaultBodyLimit::max(attachments::MAX_MANIFEST_BODY)),
        )
        .route(
            "/api/v1/backup/target",
            get(backup::get_target)
                .put(backup::put_target)
                .delete(backup::delete_target)
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route("/api/v1/backup/resync", post(backup::resync))
        .route(
            "/api/v1/integrations/{id}/github/installations",
            get(backup::list_installations),
        )
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
            get(credential_connections::list)
                .post(credential_connections::create)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/credential-connections/{id}",
            put(credential_connections::update)
                .delete(credential_connections::delete)
                .layer(DefaultBodyLimit::max(32 * 1024)),
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
        .route("/api/v1/connections/discover", post(connections::discover))
        .route(
            "/api/v1/connections/{id}",
            get(connections::get)
                .patch(connections::update_policy)
                .delete(connections::delete),
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
            "/api/v1/connections/{id}/mint",
            post(connections::mint).layer(DefaultBodyLimit::max(32 * 1024)),
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
            "/api/v1/connections/{id}/github/repos",
            get(connections::list_github_repos)
                .post(connections::create_github_repo)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/oauth/callback/{provider_id}",
            get(connections::oauth_callback),
        )
}
