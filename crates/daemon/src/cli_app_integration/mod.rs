//! CLI app-integration routes (`/v1/cli/app-integration/*`).
use axum::{
    routing::{get, post},
    Router,
};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::App;

mod auth;
mod cors;
mod handlers;
mod pairing;
mod root_enroll;
mod root_trust;
mod root_trust_status;

pub(crate) use root_trust::daemon_state_dir;

pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

pub(crate) type SharedCliAppIntegration =
    Arc<Mutex<opensesame_cli_app_integration::CliAppIntegrationHost>>;

/// In-memory host, with the root trust key marked enrolled when the state dir has a record.
pub(crate) fn open_store(state_dir: Option<&Path>) -> SharedCliAppIntegration {
    let mut host = opensesame_cli_app_integration::CliAppIntegrationHost::new();
    if let Some(dir) = state_dir {
        root_trust::apply_at_startup(&mut host, dir);
    }
    Arc::new(Mutex::new(host))
}

pub(crate) fn routes(app: &App) -> Router<App> {
    let browser = Router::new()
        .route("/v1/cli/app-integration/pending", get(handlers::pending))
        .route(
            "/v1/cli/app-integration/root-trust/status",
            get(root_trust_status::root_trust_status),
        )
        .route("/v1/cli/app-integration/respond", post(handlers::respond))
        .route(
            "/v1/cli/app-integration/pairing/confirm",
            post(pairing::pairing_confirm),
        )
        .route(
            "/v1/cli/app-integration/pairing/challenge",
            get(pairing::pairing_challenge),
        )
        .route(
            "/v1/cli/app-integration/pairing",
            post(pairing::pairing_exchange).delete(pairing::pairing_revoke),
        )
        .route(
            "/v1/cli/app-integration/pairing/webauthn",
            post(pairing::pairing_register_webauthn),
        )
        .route(
            "/v1/operator/cli-app-integration/pair/registration",
            post(pairing::pairing_arm_registration),
        )
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            cors::cors,
        ));
    Router::new()
        .route("/v1/cli/app-integration/ensure", post(handlers::ensure))
        .route(
            "/v1/cli/app-integration/daemon-attest",
            post(handlers::daemon_attest),
        )
        .route(
            "/v1/operator/cli-app-integration/pair",
            post(pairing::pairing_issue_operator),
        )
        .merge(root_enroll::routes())
        .merge(browser)
}

#[cfg(test)]
mod root_enroll_tests;
#[cfg(test)]
mod tests;
