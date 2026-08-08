use clap::Parser;
use std::{env, net::SocketAddr};

pub const DEV_OPERATOR_TOKEN: &str = "opensesame-dev-operator";

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (aa, bb) = (a.as_bytes(), b.as_bytes());
    if aa.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in aa.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Parser, Debug, Clone)]
#[command(name = "opensesame-gateway")]
pub struct Args {
    #[arg(long, env = "OPENSESAME_LISTEN", default_value = "127.0.0.1:8787")]
    pub listen: SocketAddr,
    #[arg(
        long,
        env = "OPENSESAME_RESOURCE",
        default_value = "https://opensesame.local"
    )]
    pub resource: String,
    #[arg(
        long,
        env = "OPENSESAME_ISSUER",
        default_value = "https://keycloak.local/realms/opensesame"
    )]
    pub issuer: String,
    #[arg(long, env = "OPENSESAME_DB", default_value = "sqlite::memory:")]
    pub database_url: String,
    #[arg(long, env = "OPENSESAME_TASK_DB", default_value = "")]
    pub task_database_url: String,
}

pub fn is_production_env() -> bool {
    env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
        || env::var("NODE_ENV").ok().as_deref() == Some("production")
}

pub fn dev_bootstrap_enabled() -> bool {
    env::var("OPENSESAME_DEV_BOOTSTRAP")
        .ok()
        .is_some_and(|v| v == "true" || v == "1")
}

pub fn cors_origins() -> Vec<String> {
    opensesame_host_core::http_security::cors_origins_from_env()
}

pub fn assert_cors_origins() -> Result<(), String> {
    opensesame_host_core::http_security::assert_cors_origins_allowed(
        &cors_origins(),
        is_production_env(),
    )
}

/// Receipt signing key, from `OPENSESAME_RECEIPT_SIGNING_KEY` (base64 32-byte seed).
///
/// Receipts are the non-repudiation record and the store outlives the process, so
/// an ephemeral key means every receipt written before a restart verifies as
/// `valid: false` — indistinguishable from tampering. Production must supply one.
pub fn resolve_receipt_signer() -> Result<opensesame_audit::ReceiptSigner, String> {
    match env::var("OPENSESAME_RECEIPT_SIGNING_KEY") {
        Ok(seed) if !seed.trim().is_empty() => {
            opensesame_audit::ReceiptSigner::from_seed_b64(&seed).map_err(|e| e.to_string())
        }
        _ if is_production_env() => Err(
            "OPENSESAME_RECEIPT_SIGNING_KEY unset in production; receipts would be \
             unverifiable after restart"
                .into(),
        ),
        _ => {
            tracing::warn!(
                "OPENSESAME_RECEIPT_SIGNING_KEY unset; using an ephemeral receipt key (dev only)"
            );
            Ok(opensesame_audit::ReceiptSigner::generate())
        }
    }
}

pub fn resolve_operator_token() -> String {
    match env::var("OPENSESAME_OPERATOR_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => {
            if is_production_env() {
                tracing::error!(
                    "OPENSESAME_OPERATOR_TOKEN unset in production — operator routes will deny"
                );
                String::new()
            } else {
                tracing::warn!(
                    "OPENSESAME_OPERATOR_TOKEN unset; using {DEV_OPERATOR_TOKEN} (dev only)"
                );
                DEV_OPERATOR_TOKEN.into()
            }
        }
    }
}
