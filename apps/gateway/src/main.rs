//! `OpenSesame` Host API (gateway).
#![allow(clippy::result_large_err)] // axum handlers return Response in Err
#![cfg_attr(test, allow(clippy::await_holding_lock))] // Tests serialize process-global env mutations.

mod app_state;
mod backup;
mod backup_bus;
mod backup_target;
mod bootstrap;
pub use opensesame_gateway::cert_issuers;
mod config;
mod connector_egress;
mod dev_pki;
mod github_webhook;
mod identity_mapping;
mod lifecycle;
mod middleware;
mod oci_component;
mod routes;
mod sync_actor;
mod task_engine;
mod taskbus_config;

use clap::Parser;
use config::Args;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,tower_http=info")
        .json()
        .init();

    let args = Args::parse();
    config::assert_cors_origins().map_err(anyhow::Error::msg)?;
    let state = app_state::build(args.clone()).await?;
    // The backup actor drains the transactional outbox for the process's
    // lifetime; secret mutations wake it via `backup_notify` (ADR 0039).
    tokio::spawn(backup::run(state.clone()));
    // When TaskBus is NATS, a dedicated durable consumer accelerates wakes.
    tokio::spawn(backup_bus::run_system_wake_consumer(state.clone()));
    // SYNC_ACTOR: drains `sync.config.dirty` from the config sync outbox and
    // fans out `sync_all_for_config`; config-value mutations wake it via
    // `sync_notify`, the tick covers everything else.
    tokio::spawn(sync_actor::run(state.clone()));
    // LIFECYCLE_SCANNER: the single expiry detector (ADR 0073). Gathers every
    // deadline — certificates, authorities, signers, credentials, rotation
    // policies — and publishes what each one owes. Rotation is a *subscriber*
    // to that feed rather than a second due-check of its own, so our own
    // rotations exercise the same hook a third-party tool receives.
    tokio::spawn(lifecycle::scanner::run(state.clone()));
    // LIFECYCLE_DELIVERY: drains the outbound hook ledger with the ADR 0039
    // saga — claim under lease, exponential backoff, visible dead letters.
    tokio::spawn(lifecycle::delivery::run(state.clone()));
    let hsts = args.resource.starts_with("https://");
    let app = opensesame_host_core::http_security::apply_http_security(
        routes::router(state),
        &config::cors_origins(),
        hsts,
    );

    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    tracing::info!(%listen, "opensesame gateway listening");
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod pact_coverage {
    /// Mutation oracles for Host durable / quota / consent paths.
    /// See `docs/validation/pact.md`.
    #[test]
    fn webhook_verifies_then_claims_then_appends() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("github_webhook.rs"),
            &[
                "if !well_formed_hub_signature",
                "configured_webhook_secret(&st)",
                "if !verify_hub_signature_256",
                "claim_webhook_body(&st",
                "append_webhook_outbox(&st",
            ],
        );
        opensesame_host_core::pact::check_then_set_admits_double_claim();
        opensesame_host_core::pact::exclusive_claim_is_single_winner();
    }

    #[test]
    fn agent_complete_is_operator_gated_before_claim_locks() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/agents.rs"),
            &[
                "claim_token alone must not self-complete",
                "must match create_identity",
                "match complete_gate(",
            ],
        );
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/agents.rs"),
            &["st.claims.lock()", "map.len() >= 256"],
        );
    }

    #[test]
    fn device_capacity_check_holds_the_map_lock() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/device.rs"),
            &[
                "device_codes.lock()",
                "map.len() >= MAX_PENDING_DEVICE_CODES",
                "map.insert",
            ],
        );
    }

    #[test]
    fn rotation_authorizes_then_loads_connection_then_enqueues() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/rotation.rs"),
            &[
                "fn authorize(st: &AppState, headers: &axum::http::HeaderMap)",
                "validate_target(&st",
                "let job = match request_rotation(",
            ],
        );
    }

    #[test]
    fn sync_blobs_require_session_before_opaque_contract() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/sync_blobs.rs"),
            &[
                "require_session(&st, &headers)",
                "assert_opaque_sync_json(&raw)",
            ],
        );
    }

    #[test]
    fn backup_resync_is_configurator_gated_before_outbox() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/backup.rs"),
            &[
                "pub async fn resync",
                "if !resync_allowed()",
                "reason\":\"requested\",\"organization_id\"",
            ],
        );
    }

    #[test]
    fn nats_callout_ignores_self_asserted_project_ids() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/nats_callout.rs"),
            &["project_ids: vec![]"],
        );
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/nats_callout.rs"),
            &[
                "identity mapping resolve failed",
                "decide_nats_callout(&cfg, req, mapped)",
            ],
        );
    }

    #[test]
    fn changelog_lists_only_the_caller_organization() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/changelog.rs"),
            &[
                "caller.organization(st.connection_organization)",
                ".list_changelog(&organization_id, &project_id, limit, query.before_seq)",
            ],
        );
    }

    #[test]
    fn taskbus_ping_is_configurator_gated() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/taskbus_config.rs"),
            &["pub async fn ping", "view(&resolved, \"reachable\""],
        );
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/taskbus_config.rs"),
            &["fn require_configurator", "pub async fn ping"],
        );
    }
}
