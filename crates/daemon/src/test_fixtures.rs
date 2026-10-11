//! Shared daemon test fixtures (kept out of `lib.rs` for the line budget).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use super::cli_app_integration;
use super::plugin_routes;
use super::ratelimit;
use super::tailnet_admin_routes;
use super::App;

pub(crate) fn test_operator_token() -> &'static str {
    static TOKEN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
    });
    &TOKEN
}

pub(crate) fn test_state(host_api: &str) -> App {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(400))
        .connect_timeout(std::time::Duration::from_millis(200))
        .build()
        .unwrap();
    App {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        capabilities: Arc::new(Mutex::new(HashMap::new())),
        host_api: host_api.to_string(),
        identity_api: "http://127.0.0.1:1".into(),
        http,
        operator_token: test_operator_token().into(),
        allowed_uids: opensesame_uds_authn::default_allowed_uids(),
        discover_limiter: Arc::new(ratelimit::TokenBucket::default()),
        promote_limiter: Arc::new(ratelimit::TokenBucket::default()),
        invoke_limiter: Arc::new(ratelimit::TokenBucket::default()),
        mint_limiter: Arc::new(ratelimit::TokenBucket::default()),
        invoker: Arc::new(opensesame_invoke_through::Invoker::new()),
        token_source_factory: Arc::new(|_| None),
        duress_peer: None,
        vault_drive: None,
        plugins: plugin_routes::PluginHost::at(None, Arc::new(|_| None)),
        cli_app_integration: cli_app_integration::fresh_store(),
        tailnet: tailnet_admin_routes::TailnetAdminHost::detached(),
    }
}
