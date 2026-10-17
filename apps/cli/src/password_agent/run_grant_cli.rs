//! Native `run --grant` claims and the `lease approve-run` ceremony
//! (ADR 0205 decision 4), kept beside the lease store they share.
use opensesame_connector_host::password_agent::{lease, run_grant};
use std::io::IsTerminal;

use super::{lease_store::Store, run_args::RunArgs};

fn binding(args: &RunArgs) -> anyhow::Result<run_grant::RunGrantBinding> {
    run_grant::describe(
        &args.env,
        &args.mount,
        args.agent_proxy,
        &args.paths,
        &args.methods,
    )
}

/// Claim one use of the named grant for exactly this run. An explicit
/// `--grant` fails closed: it never falls back to per-run approval.
///
/// # Errors
/// Returns an error when the grant does not authorize this run.
pub(super) async fn claim_grant(args: &RunArgs) -> anyhow::Result<bool> {
    let Some(id) = &args.grant else {
        return Ok(false);
    };
    let binding = binding(args)?;
    Store::open()
        .await?
        .claim_run(id, &binding)
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "Run grant is invalid, expired, revoked, exhausted, or does not match this run (details suppressed)."
            )
        })?;
    Ok(true)
}

fn receipt(value: &run_grant::RunGrant) -> anyhow::Result<serde_json::Value> {
    let mut receipt = value.receipt();
    let instant = |millis: i64| {
        Ok::<_, anyhow::Error>(
            chrono::DateTime::from_timestamp_millis(millis)
                .ok_or_else(|| anyhow::anyhow!("Invalid run grant timestamp"))?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
    };
    receipt["createdAt"] = serde_json::json!(instant(value.created_at)?);
    receipt["expiresAt"] = serde_json::json!(instant(value.expires_at)?);
    Ok(receipt)
}

/// # Errors
/// Returns an error unless a human at an interactive terminal grants.
pub(super) async fn approve_run(args: &RunArgs, expires_in: &str, uses: u32) -> anyhow::Result<()> {
    anyhow::ensure!(
        args.grant.is_none(),
        "--grant consumes a run grant; it cannot approve one"
    );
    let binding = binding(args)?;
    let ttl = lease::limits(expires_in, uses)?;
    anyhow::ensure!(
        std::io::stdin().is_terminal() && std::io::stderr().is_terminal(),
        "Run-grant approval requires an interactive terminal"
    );
    eprintln!(
        "Approve run grant: {}",
        serde_json::json!({"capability":binding.capability,"assignments":binding.assignments,"mounts":binding.mounts,"agentProxy":binding.agent_proxy,"paths":binding.paths,"methods":binding.methods,"expiresIn":expires_in,"uses":uses})
    );
    let granted = Store::open().await?.grant_run(binding, ttl, uses).await?;
    super::print(&receipt(&granted)?)
}

/// # Errors
/// Returns an error when the grant metadata is unavailable.
pub(super) async fn run_status(id: &str) -> anyhow::Result<()> {
    super::print(&receipt(&Store::open().await?.run_grant_status(id).await?)?)
}

/// # Errors
/// Returns an error when the grant metadata is unavailable.
pub(super) async fn run_revoke(id: &str) -> anyhow::Result<()> {
    super::print(&receipt(&Store::open().await?.revoke_run(id).await?)?)
}
