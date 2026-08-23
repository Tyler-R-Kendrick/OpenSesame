use clap::Parser;
use std::{env, net::SocketAddr};

pub const DEV_OPERATOR_TOKEN: &str = "opensesame-dev-operator";
pub const DEV_CLAIM_PEPPER: &str = "opensesame-dev-claim-pepper";

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    // Compare digests so a length mismatch cannot return early.
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
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
    #[arg(
        long,
        env = "OPENSESAME_DB",
        default_value = ".tools/run/opensesame.db"
    )]
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

/// Vault KV v2 read facade (`apps/gateway/src/routes/kv_facade.rs`), default off.
///
/// Read the same way `dev_bootstrap_enabled` is, and for the same reason: the
/// router is built from `AppState`, so a flag that decides whether a route
/// group is *mounted at all* has to be readable without threading a new field
/// through state. Off means the routes do not exist, so a probe sees 404 rather
/// than a 403 that confirms the surface is there.
pub fn kv_facade_enabled() -> bool {
    env::var("OPENSESAME_KV_FACADE")
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

/// Keys trusted to have signed a receipt: the active signer plus any retired
/// public keys from `OPENSESAME_RECEIPT_VERIFY_KEYS` (comma or whitespace
/// separated base64 32-byte ed25519 public keys).
///
/// Verification needs no secret, so rotating the signer does not require keeping
/// the old seed — only its public half — and old receipts stay verifiable.
pub fn resolve_receipt_verifier(
    signer: &opensesame_audit::ReceiptSigner,
) -> Result<opensesame_audit::ReceiptVerifier, String> {
    let mut verifier = opensesame_audit::ReceiptVerifier::new();
    verifier.trust(signer.verifying_key());
    let retired = env::var("OPENSESAME_RECEIPT_VERIFY_KEYS").unwrap_or_default();
    for entry in retired.split([',', ' ', '\n', '\t']) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        verifier.trust_b64(entry).map_err(|e| e.to_string())?;
    }
    Ok(verifier)
}

/// Pepper for low-entropy digests (user codes).
///
/// A user code is ~2^35 possibilities, so a keyless digest of one is recoverable
/// by exhaustion; the pepper is what makes the stored digest worth storing.
pub fn resolve_claim_pepper() -> String {
    match env::var("OPENSESAME_CLAIM_PEPPER") {
        Ok(p) if !p.is_empty() => p,
        _ => {
            if is_production_env() {
                tracing::error!(
                    "OPENSESAME_CLAIM_PEPPER unset in production — user codes would be \
                     recoverable from their digests"
                );
                String::new()
            } else {
                tracing::warn!("OPENSESAME_CLAIM_PEPPER unset; using a dev pepper (dev only)");
                DEV_CLAIM_PEPPER.into()
            }
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
