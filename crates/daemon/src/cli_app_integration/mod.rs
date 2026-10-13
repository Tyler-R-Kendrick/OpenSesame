//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    routing::{get, post},
    Router,
};
use std::sync::{Arc, Mutex};

use crate::App;

mod auth;
mod cors;
mod handlers;
mod pairing;

pub(crate) type SharedCliAppIntegration = Arc<Mutex<opensesame_cli_app_integration::CliAppIntegrationHost>>;

pub(crate) fn fresh_store() -> SharedCliAppIntegration {
    opensesame_cli_app_integration::fresh_host()
}

pub(crate) fn routes(app: &App) -> Router<App> {
    let browser = Router::new()
        .route("/v1/cli/app-integration/pending", get(handlers::pending))
        .route("/v1/cli/app-integration/respond", post(handlers::respond))
        .route(
            "/v1/cli/app-integration/pairing/confirm",
            post(pairing::pairing_confirm),
        )
        .route(
            "/v1/cli/app-integration/pairing",
            post(pairing::pairing_exchange).delete(pairing::pairing_revoke),
        )
        .layer(axum::middleware::from_fn_with_state(app.clone(), cors::cors));
    Router::new()
        .route("/v1/cli/app-integration/ensure", post(handlers::ensure))
        .route(
            "/v1/operator/cli-app-integration/pair",
            post(pairing::pairing_issue_operator),
        )
        .merge(browser)
}

#[cfg(test)]
mod tests;
