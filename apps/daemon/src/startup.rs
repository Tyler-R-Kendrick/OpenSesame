//! Startup validation completes before any listener or network bridge starts.
use super::{cli_token_source_factory, peer_auth, ratelimit, router, App, Args};
use axum::Router;
use std::{
    collections::HashMap,
    env,
    sync::{Arc, Mutex},
};

pub(super) fn enable_network_bridge(listen: &str) {
    if super::tailscale::enable_serve(listen).is_ok() {
        tracing::info!("explicit daemon network bridge enabled");
    } else {
        tracing::warn!("daemon network bridge unavailable");
    }
}

fn resolve_operator_token() -> anyhow::Result<String> {
    let token = env::var("OPENSESAME_OPERATOR_TOKEN").unwrap_or_default();
    anyhow::ensure!(
        token.len() >= 32 && token.trim() == token
            && token.bytes().all(|byte| byte.is_ascii_graphic())
            && token.bytes().collect::<std::collections::HashSet<_>>().len() >= 8,
        "OPENSESAME_OPERATOR_TOKEN requires an explicitly provisioned high-entropy secret of at least 32 bytes"
    );
    Ok(token)
}

fn network_bridge_enabled() -> anyhow::Result<bool> {
    match env::var("OPENSESAME_DAEMON_NETWORK_BRIDGE").ok().as_deref() {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => anyhow::bail!("OPENSESAME_DAEMON_NETWORK_BRIDGE must be exactly 0 or 1"),
    }
}

pub(super) fn build_state(args: &Args) -> anyhow::Result<(App, bool)> {
    use opensesame_host_core::deployment_mode::{classify, from_env};
    let mut endpoints = vec![args.host_api.as_str(), args.identity_api.as_str()];
    let public = env::var("OPENSESAME_PUBLIC_URL").ok();
    if let Some(value) = public.as_deref() {
        endpoints.push(value);
    }
    let mut exposure = classify(&[args.listen.as_str()], &endpoints).map_err(anyhow::Error::msg)?;
    if network_bridge_enabled()? {
        exposure = opensesame_host_core::deployment_mode::ExposureClass::Networked;
    }
    let deployment = from_env(exposure).map_err(anyhow::Error::msg)?;
    let operator_token = resolve_operator_token()?;
    if deployment.production_safeguards() {
        anyhow::ensure!(
            [&args.host_api, &args.identity_api]
                .iter()
                .all(|url| url.starts_with("https://")
                    || opensesame_host_core::daemon::base_url_is_local(url)),
            "networked daemon upstreams require HTTPS"
        );
    }
    let host_api = args.host_api.trim_end_matches('/').to_string();
    let hsts = host_api.starts_with("https://");
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    Ok((
        App {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            host_api,
            identity_api: args.identity_api.trim_end_matches('/').to_string(),
            http,
            operator_token,
            allowed_uids: peer_auth::allowed_uids(args.allowed_uids.as_deref()),
            discover_limiter: Arc::new(ratelimit::TokenBucket::default()),
            promote_limiter: Arc::new(ratelimit::TokenBucket::default()),
            invoke_limiter: Arc::new(ratelimit::TokenBucket::default()),
            mint_limiter: Arc::new(ratelimit::TokenBucket::new(4.0, 1.0)),
            invoker: Arc::new(opensesame_invoke_through::Invoker::new()),
            token_source_factory: cli_token_source_factory(),
        },
        hsts,
    ))
}

pub(super) fn secured_router(state: App, hsts: bool) -> anyhow::Result<Router> {
    let cors_origins = opensesame_host_core::http_security::cors_origins_from_env();
    let is_production = true;
    opensesame_host_core::http_security::assert_cors_origins_allowed(&cors_origins, is_production)
        .map_err(anyhow::Error::msg)?;
    Ok(opensesame_host_core::http_security::apply_http_security(
        router(state),
        &cors_origins,
        hsts,
    ))
}
