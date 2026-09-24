//! `OpenSesame` Host API: the routes, background actors and transports that
//! `opensesame host run` serves.
#![allow(clippy::result_large_err)] // axum handlers return Response in Err
#![cfg_attr(test, allow(clippy::await_holding_lock))] // Tests serialize process-global env mutations.

mod app_state;
mod backup;
mod backup_bus;
mod backup_target;
mod bootstrap;
mod breach;
mod browser_pairing_proof;
mod callback_ingress;
pub mod cert_issuers;
mod config;
mod connector_egress;
mod dev_pki;
mod github_webhook;
mod host_authorization;
mod identity_mapping;
mod identity_mapping_tls;
mod lifecycle;
mod managed_certs;
mod managed_certs_tls;
mod middleware;
// Reached only through the `wasm-connectors` connector runtime.
#[cfg_attr(not(feature = "wasm-connectors"), allow(dead_code))]
mod oci_component;
mod openfga_project;
mod routes;
mod security;
mod session_channel;
mod session_claims;
mod shared_session_fence;
mod sync_actor;
mod task_engine;
mod taskbus_config;
#[cfg(test)]
mod test_principals;
mod transport;
mod transport_lifecycle;

pub use config::Args;

/// Serve the Host API, and every background actor it owns, until the
/// listeners stop.
///
/// # Errors
///
/// Fails when startup security refuses the configuration, the store cannot
/// be opened, a configured secure listener is broken, or a listener cannot
/// be bound. Nothing is served in any of those cases.
pub async fn run(args: Args) -> anyhow::Result<()> {
    config::assert_cors_origins().map_err(anyhow::Error::msg)?;
    let state = app_state::build(args.clone()).await?;
    let state_for_serve = state.clone();
    // The backup actor drains the transactional outbox for the process's
    // lifetime; secret mutations wake it via `backup_notify` (ADR 0039).
    tokio::spawn(backup::run(state.clone()));
    // When TaskBus is NATS, a dedicated durable consumer accelerates wakes.
    tokio::spawn(backup_bus::run_system_wake_consumer(state.clone()));
    // SYNC_ACTOR: drains `sync.config.dirty` from the config sync outbox and
    // fans out `sync_all_for_config`; config-value mutations wake it via
    // `sync_notify`, the tick covers everything else.
    tokio::spawn(sync_actor::run(state.clone()));
    // LIFECYCLE_SCANNER: the single expiry detector (ADR 0074). Gathers every
    // deadline — certificates, authorities, signers, credentials, rotation
    // policies — and publishes what each one owes. Rotation is a *subscriber*
    // to that feed rather than a second due-check of its own, so our own
    // rotations exercise the same hook a third-party tool receives.
    tokio::spawn(lifecycle::scanner::run(state.clone()));
    // Transport renewal retries and bounded trust-overlap reconcile (ADR 0132).
    transport_lifecycle::boot::attach(&state);
    // The durable revoked-leaf denylist and the stored trust profiles are in
    // force before anything is served; an unreadable denylist stops boot.
    transport_lifecycle::boot::restore(&state).await?;
    tokio::spawn(transport_lifecycle::renewal::run(state.clone()));
    // Replicas sharing one store converge on the stored binding set within
    // `transport::bindings::REFRESH_INTERVAL` (a revocation's denials above all).
    tokio::spawn(transport::bindings::run_refresh(state.clone()));
    // …and on the stored trust profiles and revoked-leaf denylist, same cadence.
    tokio::spawn(transport_lifecycle::boot::run_refresh(state.clone()));
    // LIFECYCLE_DELIVERY: drains the outbound hook ledger with the ADR 0039
    // saga — claim under lease, exponential backoff, visible dead letters.
    tokio::spawn(security::delivery::run(state.clone()));
    tokio::spawn(breach::scanner::run(state.clone()));
    let hsts = args.resource.starts_with("https://");
    let callbacks = callback_ingress::from_env(state.db.clone())?;
    let app = opensesame_host_core::http_security::apply_http_security(
        routes::router(state).merge(callbacks),
        &config::cors_origins(),
        hsts,
    );

    // Plain listener always; the optional mTLS / workload-identity secure
    // listener beside it when configured (ADR 0132). A configured-but-broken
    // secure profile returns Err here, so nothing serves.
    transport::boot::serve(state_for_serve, &args, app).await
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
                "access::may_request(",
                "upsert_rotation_policy(",
                "let job = match request_rotation(",
            ],
        );
    }

    /// INV-BUDGET: `OpenFGA` and intent building can refuse, and a refusal
    /// after the hold would leave a reservation nothing ever releases.
    #[test]
    fn invoke_authorizes_fully_before_holding_budget() {
        // The file opens with a test-only import, so read from the handler on.
        let src = include_str!("routes/intents.rs");
        let handler = &src[src.find("let resolved = resolve_invocation(").unwrap()..];
        opensesame_host_core::pact::assert_source_order(
            handler,
            &[
                "authorize_invocation(&st",
                "intents_projection::authorize_openfga(",
                "let intent = build_intent(",
                "intents_budget::spend_invoke_budgets(",
                "intents_queue::dispatch_or_hold(",
            ],
        );
    }

    /// ADR 0076: the egress fence must bite before the sealed credential is
    /// opened, so a denied verification never causes the credential to be
    /// decrypted at all. `Invoker` splits preflight from execute precisely so
    /// this order is expressible; this pins that the broker keeps it.
    #[test]
    fn rotation_verify_preflights_before_opening_the_credential() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("../../../crates/connection-broker/src/rotation_verify.rs"),
            &[
                "let prepared = match invoker.preflight(request) {",
                "let Some(token) = self.resolve_bearer(row).await? else {",
                "invoker.execute(&token, prepared).await",
            ],
        );
    }

    /// ADR 0076: rotation verifies before it activates, which is what makes the
    /// machine's Kani-proven verify-before-revoke ordering mean something.
    #[test]
    fn rotation_verifies_before_activating_the_candidate() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("../../../crates/connection-broker/src/rotation.rs"),
            &[
                "RotationState::CandidateInstalled,",
                "verify_candidate(&context, state).await?;",
                "RotationState::CandidateActivated,",
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
                "require_configurator",
                "if !resync_allowed()",
                "queue_backup_resync",
                "\"requested\"",
            ],
        );
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/backup.rs"),
            &[
                "async fn queue_backup_resync",
                "\"organization_id\": organization",
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
                "decide_nats_callout(cfg, req, mapped)",
            ],
        );
    }

    #[test]
    fn changelog_lists_only_the_caller_organization() {
        opensesame_host_core::pact::assert_source_order(
            include_str!("routes/changelog.rs"),
            &[
                "access::organization(&st, &caller, &headers)",
                "access::project(",
                "ResourcePermission::Keys",
                "let organization_id = organization.to_string();",
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
