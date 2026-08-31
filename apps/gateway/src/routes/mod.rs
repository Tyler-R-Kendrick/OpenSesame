mod a2h;
mod aauth;
mod admin;
mod agents;
mod attachments;
mod backup;
pub(crate) mod certmgr_ca;
pub(crate) mod certmgr_policy;
pub(crate) mod certmgr_profile;
mod certs;
mod changelog;
mod connections;
#[cfg(test)]
mod contract;
mod credential_connections;
mod delegations;
mod device;
pub(crate) mod github_app;
mod health;
mod intents;
mod kv_facade;
mod lifecycle;
mod nats_callout;
mod protected_resource;
mod receipts;
mod relay;
mod rotation;
mod secret_configs;
mod security;
mod session;
mod shared_sessions;
mod sync;
mod sync_blobs;
mod sync_targets;
mod taskbus_config;
mod tasks;

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::app_state::AppState;
use crate::config;
use crate::github_webhook;

#[expect(
    clippy::too_many_lines,
    reason = "the router is the single declarative catalog audited against the OpenAPI contract"
)]
pub fn router(state: AppState) -> Router {
    let router = Router::new()
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
        .route("/api/v1/session/local", post(session::local_mint))
        .route("/api/v1/sessions/revoke", post(session::revoke))
        .route("/api/v1/whoami", get(session::whoami))
        .route("/api/v1/nats/auth/callout", post(nats_callout::callout))
        .route(
            "/api/v1/operator/taskbus",
            get(taskbus_config::get_config)
                .put(taskbus_config::put_config)
                .layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/v1/operator/taskbus/ping", post(taskbus_config::ping))
        .route("/api/v1/certs", get(certs::list_issued))
        .route("/api/v1/certs/ca", get(certs::get_ca))
        .route(
            "/api/v1/certs/issue",
            post(certs::issue).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/v1/certs/deliveries/{request_id}/ack",
            post(certs::acknowledge_delivery),
        )
        // ADR 0075: reveal a host-custody private key. Human/operator only and
        // deliberately absent from every agent surface.
        .route("/api/v1/certs/{id}/key", get(certs::reveal_key))
        // ADR 0066/0067: certificate-manager authorities — root and
        // intermediate CAs, externally signed chains, renewal and CRL
        // distribution settings (plan §5.6, 16 KiB; 512 KiB for chain import).
        .route(
            "/api/v1/certmgr/cas",
            get(certmgr_ca::list_cas)
                .post(certmgr_ca::create_ca)
                .layer(DefaultBodyLimit::max(certmgr_ca::MAX_BODY)),
        )
        .route(
            "/api/v1/certmgr/cas/{id}",
            get(certmgr_ca::get_ca)
                .patch(certmgr_ca::patch_ca)
                .layer(DefaultBodyLimit::max(certmgr_ca::MAX_BODY)),
        )
        .route("/api/v1/certmgr/cas/{id}/csr", get(certmgr_ca::export_csr))
        .route(
            "/api/v1/certmgr/cas/{id}/import-chain",
            post(certmgr_ca::import_chain)
                .layer(DefaultBodyLimit::max(certmgr_ca::MAX_IMPORT_BODY)),
        )
        .route(
            "/api/v1/certmgr/cas/{id}/renew",
            post(certmgr_ca::renew_ca).layer(DefaultBodyLimit::max(certmgr_ca::MAX_BODY)),
        )
        .route(
            "/api/v1/certmgr/cas/{id}/signing-config",
            get(certmgr_ca::get_signing_config)
                .patch(certmgr_ca::patch_signing_config)
                .layer(DefaultBodyLimit::max(certmgr_ca::MAX_BODY)),
        )
        // ADR 0066: certificate-manager policies — the constraint documents an
        // issuance request is evaluated against (plan §5.4, 16 KiB).
        .route(
            "/api/v1/certmgr/policies",
            get(certmgr_policy::list)
                .post(certmgr_policy::create)
                .layer(DefaultBodyLimit::max(certmgr_policy::MAX_BODY)),
        )
        .route(
            "/api/v1/certmgr/policies/{id}",
            get(certmgr_policy::get)
                .patch(certmgr_policy::update)
                .delete(certmgr_policy::delete)
                .layer(DefaultBodyLimit::max(certmgr_policy::MAX_BODY)),
        )
        // ADR 0066: certificate-manager profiles — a CA plus a policy plus the
        // defaults an application issues with (plan §5.4, 16 KiB).
        .route(
            "/api/v1/certmgr/profiles",
            get(certmgr_profile::list)
                .post(certmgr_profile::create)
                .layer(DefaultBodyLimit::max(certmgr_policy::MAX_BODY)),
        )
        .route(
            "/api/v1/certmgr/profiles/{id}",
            get(certmgr_profile::get)
                .patch(certmgr_profile::update)
                .delete(certmgr_profile::delete)
                .layer(DefaultBodyLimit::max(certmgr_policy::MAX_BODY)),
        )
        .route("/api/v1/providers", get(connections::list_providers))
        .route(
            "/api/v1/custom-providers",
            post(connections::create_custom_provider).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/v1/custom-providers/{id}",
            delete(connections::delete_custom_provider),
        )
        .route(
            "/api/v1/providers/github/app",
            post(github_app::register_start).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/v1/oauth/github-app/callback",
            get(github_app::register_callback),
        )
        .route(
            "/api/v1/webhooks/github",
            get(github_webhook::webhook_get)
                .post(github_webhook::webhook)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/v1/attachments/target",
            get(attachments::get_target)
                .put(attachments::put_target)
                .delete(attachments::delete_target),
        )
        .route(
            "/api/v1/attachments/replicate/chunk",
            post(attachments::replicate_chunk)
                .layer(DefaultBodyLimit::max(attachments::MAX_CHUNK_BODY)),
        )
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
        .route("/api/v1/intents", post(intents::create))
        // ADR 0044: delegation offer lifecycle. Mint/list/revoke are
        // owner surfaces; present and claim are the shareable ceremony's.
        .route(
            "/api/v1/delegations",
            get(delegations::list).post(delegations::mint),
        )
        .route("/api/v1/delegations/present", post(delegations::present))
        .route("/api/v1/delegations/claim", post(delegations::claim))
        .route("/api/v1/delegations/offers", get(delegations::list_offers))
        .route(
            "/api/v1/delegations/offers/{id}",
            delete(delegations::revoke_offer),
        )
        .route("/api/v1/delegations/{id}", delete(delegations::revoke))
        .route("/api/v1/delegations/{id}/narrow", post(delegations::narrow))
        .route(
            "/api/v1/shared-sessions",
            get(shared_sessions::discover).post(shared_sessions::open),
        )
        .route("/api/v1/shared-sessions/{id}", get(shared_sessions::detail))
        .route(
            "/api/v1/shared-sessions/{id}/activity",
            post(shared_sessions::announce_activity),
        )
        .route(
            "/api/v1/shared-sessions/{id}/events",
            get(shared_sessions::events),
        )
        .route(
            "/api/v1/shared-sessions/{id}/grants",
            post(shared_sessions::grant),
        )
        .route(
            "/api/v1/shared-sessions/{id}/grants/{grant_id}",
            delete(shared_sessions::revoke),
        )
        .route(
            "/api/v1/shared-sessions/{id}/join-requests",
            get(shared_sessions::list_join_requests).post(shared_sessions::ask_to_join),
        )
        .route(
            "/api/v1/shared-sessions/{id}/join-requests/{request_id}/decide",
            post(shared_sessions::decide_join_request),
        )
        // ADR 0046: relayed execution — dual-RPC tier. The holder's runtime
        // heartbeats, drains, decides, and reports; the delegate submits and
        // polls. Admission rules run at submit and at result.
        .route("/api/v1/relay/heartbeat", post(relay::heartbeat))
        .route("/api/v1/relay/requests", post(relay::submit))
        .route("/api/v1/relay/requests/pending", get(relay::pending))
        .route("/api/v1/relay/requests/{id}", get(relay::get))
        .route("/api/v1/relay/requests/{id}/approve", post(relay::approve))
        .route("/api/v1/relay/requests/{id}/deny", post(relay::deny))
        .route("/api/v1/relay/requests/{id}/result", post(relay::result))
        .route("/api/v1/receipts/keys", get(receipts::keys))
        .route("/api/v1/receipts/{id}", get(receipts::get))
        .route("/api/v1/receipts/{id}/verify", post(receipts::verify))
        .route("/api/v1/agent-identities", post(agents::create_identity))
        .route("/api/v1/agent-claims/{id}/poll", post(agents::poll))
        .route("/api/v1/agent-claims/{id}/complete", post(agents::complete))
        .route("/api/v1/admin/authority", post(admin::set_authority))
        .route("/api/v1/sync/push", post(sync::push))
        .route("/api/v1/sync/pull", post(sync::pull))
        // WP-F: opaque ciphertext snapshot + guarded push (never plaintext / deployment seal).
        .route(
            "/api/v1/sync/blobs/snapshot",
            post(sync_blobs::snapshot).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/sync/blobs/push",
            post(sync_blobs::push_opaque).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        // WP-D: project secret/config changelog (metadata only).
        .route(
            "/api/v1/projects/{project_id}/changelog",
            get(changelog::list_for_project),
        )
        .route("/api/v1/changelog", post(changelog::record))
        // ADR 0052: project-config secret store — write-only value intake;
        // every response is key names + version metadata, never values.
        .route(
            "/api/v1/projects/{project_id}/configs",
            get(secret_configs::list_for_project)
                .post(secret_configs::create)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/configs/{id}",
            get(secret_configs::get).delete(secret_configs::delete),
        )
        .route(
            "/api/v1/configs/{id}/secrets",
            get(secret_configs::list_keys)
                .put(secret_configs::put_secrets)
                .layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/v1/configs/{id}/secrets/{key}",
            delete(secret_configs::delete_secret),
        )
        .route(
            "/api/v1/configs/{id}/secrets/{key}/versions",
            get(secret_configs::list_versions),
        )
        .route(
            "/api/v1/configs/{id}/secrets/{key}/rollback",
            post(secret_configs::rollback).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v1/configs/{a}/compare/{b}",
            get(secret_configs::compare),
        )
        .route(
            "/api/v1/configs/{id}/branch",
            post(secret_configs::branch).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        // WP-C: sync targets — ConnectionRef fan-out; never returns secrets.
        .route(
            "/api/v1/sync-targets",
            get(sync_targets::list)
                .post(sync_targets::create)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/sync-targets/sync-all",
            post(sync_targets::sync_all).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/sync-targets/{id}",
            get(sync_targets::get).delete(sync_targets::delete),
        )
        .route(
            "/api/v1/sync-targets/{id}/sync",
            post(sync_targets::sync_one).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        // WP-E: credential rotation request (never returns secrets).
        .route(
            "/api/v1/rotations",
            get(rotation::list_jobs)
                .post(rotation::request)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/v1/rotations/{id}", get(rotation::get_job))
        // ADR 0074: expiry lifecycle hooks. The read view is any caller; the
        // subscription surface is integration configuration (owner/admin or
        // operator), like sync targets and rotation policies.
        .route("/api/v1/lifecycle/expiring", get(lifecycle::list_expiring))
        .route(
            "/api/v1/lifecycle/hooks",
            get(lifecycle::list_hooks).put(lifecycle::put_hook),
        )
        .route(
            "/api/v1/lifecycle/hooks/{id}",
            delete(lifecycle::delete_hook),
        )
        .route(
            "/api/v1/lifecycle/deliveries",
            get(lifecycle::list_deliveries),
        )
        .route("/api/v1/lifecycle/scan", post(lifecycle::scan))
        // ADR 0080: the same subscription surface, under the name that now
        // describes what it carries. The `/lifecycle/hooks` paths above stay
        // as they are — they are a published contract with registered
        // subscribers behind them, and breaking one to tidy a URL would be a
        // poor trade.
        .route(
            "/api/v1/security/hooks",
            get(lifecycle::list_hooks).put(lifecycle::put_hook),
        )
        .route(
            "/api/v1/security/hooks/{id}",
            delete(lifecycle::delete_hook),
        )
        .route(
            "/api/v1/security/deliveries",
            get(lifecycle::list_deliveries),
        )
        // ADR 0080: breach exposure.
        .route("/api/v1/security/findings", get(security::list_findings))
        .route("/api/v1/security/breach-scan", post(security::scan))
        .route("/api/v1/security/breach-check", post(security::check))
        // Unauthenticated by design: the A2H gateway holds no session, and the
        // request's HMAC is its authentication (see routes/a2h.rs).
        .route("/api/v1/a2h/callback", post(a2h::callback))
        // WP-9: durable rotation policies (owner/admin configuration surface).
        .route(
            "/api/v1/rotation/policies",
            get(rotation::list_policies)
                .put(rotation::put_policy)
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
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
        );
    // Vault KV v2 read facade (ops plane, default off). Merged rather than
    // chained so that with the flag unset the routes are absent entirely: an
    // unmounted surface answers 404, where a mounted-but-disabled one would
    // answer 403 and confirm it exists.
    let router = if config::kv_facade_enabled() {
        router.merge(kv_facade::routes())
    } else {
        router
    };
    router.with_state(state).layer(TraceLayer::new_for_http())
}
