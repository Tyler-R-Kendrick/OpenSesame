//! Optional vault-relay peer (ADR 0181).
//!
//! The Host API is gone (Tyler 2026-10-08). This crate serves only the relay
//! profile: liveness, vault-relay snapshots, and org-vault directory routes.
//! Entry: `opensesame relay run`.
#![allow(clippy::result_large_err)]

mod config;
pub mod vault_relay;

pub use config::Args;

/// Serve the vault-relay peer until the listener stops.
///
/// # Errors
///
/// Binding document refused, listen address not allowed, or bind failure.
pub async fn run(args: Args) -> anyhow::Result<()> {
    vault_relay::run(&args).await
}

/// Validate a relay bindings document (CI / operator preflight).
///
/// # Errors
///
/// Same refusals as relay startup.
pub fn bindings_for_relay(json: Option<&str>) -> Result<(), String> {
    vault_relay::bindings_for_relay(json)
}
