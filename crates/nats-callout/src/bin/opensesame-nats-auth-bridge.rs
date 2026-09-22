//! `opensesame-nats-auth-bridge`: subscribes to `$SYS.REQ.USER.AUTH` on the
//! callout account and answers every request with a Host decision.
//!
//! Configuration is environment only (see `opensesame_nats_callout::config`).
//! A missing identity, trust bundle, signing seed or Host URL is a startup
//! error, never a downgrade.

use std::sync::Arc;

use opensesame_nats_callout::bridge::{run, BridgeCore};
use opensesame_nats_callout::config::BridgeConfig;
use opensesame_nats_callout::host_client::HttpHost;
use opensesame_nats_callout::response::ResponseSigner;
use opensesame_nats_callout::xkey::CalloutXKey;
use secrecy::ExposeSecret as _;

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

#[tokio::main]
async fn main() {
    init_tracing();
    if let Err(code) = start().await {
        tracing::error!(code, "auth bridge did not start");
        std::process::exit(2);
    }
}

async fn start() -> Result<(), &'static str> {
    let config = BridgeConfig::from_env().map_err(|e| {
        tracing::error!(error = %e, "configuration");
        "malformed_configuration"
    })?;
    let signer = ResponseSigner::from_seed(config.signing_seed.expose_secret(), config.max_exp_secs)
        .map_err(|e| {
            tracing::error!(error = %e, "signing seed");
            "malformed_configuration"
        })?;
    let xkey = config
        .xkey_seed
        .as_ref()
        .map(|seed| CalloutXKey::from_seed(seed.expose_secret()))
        .transpose()
        .map_err(|e| {
            tracing::error!(error = %e, "xkey seed");
            "malformed_configuration"
        })?;
    let host = HttpHost::new(&config.host_tls, &config.host_url).map_err(|e| {
        tracing::error!(error = %e, "Host client");
        "malformed_configuration"
    })?;
    let options = config.connect_options().map_err(|e| {
        tracing::error!(error = %e, "NATS options");
        "malformed_configuration"
    })?;
    let core = Arc::new(BridgeCore {
        signer,
        server_public_keys: config.server_public_keys.clone(),
        xkey,
        target_account: config.target_account.clone(),
        callout_subject: config.callout_subject.clone(),
        source: Arc::new(host),
    });
    tracing::info!(
        account = core.signer.account_public_key(),
        target_account = core.target_account,
        pinned_servers = core.server_public_keys.len(),
        sealed = core.xkey.is_some(),
        host = config.host_url.as_str(),
        "auth bridge configured"
    );
    let client = options.connect(config.nats_url.as_str()).await.map_err(|e| {
        tracing::error!(error = %e, "NATS connect");
        "nats_unreachable"
    })?;
    run(client, core).await.map_err(|e| {
        tracing::error!(error = %e, "serve");
        "serve_failed"
    })
}
