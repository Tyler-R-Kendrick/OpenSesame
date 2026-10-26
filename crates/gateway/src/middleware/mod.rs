pub mod agent_grants;
pub mod auth;
pub mod browser_grants;
pub(crate) mod browser_user_routes;
pub(crate) mod public_enrollment;

/// Every route passes the browser and agent ceilings before its own authenticator.
pub fn guard_routes(router: axum::Router, state: crate::app_state::AppState) -> axum::Router {
    router
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            agent_grants::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            browser_grants::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            public_enrollment::guard,
        ))
}
