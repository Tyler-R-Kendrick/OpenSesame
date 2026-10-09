//! Explicitly configured workload connector host.
//!
//! Two transport profiles, chosen by `OPENSESAME_WORKER_TRANSPORT`:
//! `existing_local` (loopback plus the shared worker/operator token, exactly
//! as before) and `mtls_required` (a TLS listener that will not finish a
//! handshake without a client certificate, and an explicit service binding
//! per admitted peer). The second profile reads no token at all.
//!
//! This worker exposes readiness and a provider listing. It is deliberately
//! not a remote task executor: nothing here accepts work, and no invocation
//! endpoint is invented to give the certificate something to authorize.

mod routes;
mod transport;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use clap::Parser;
use opensesame_connector_host::providers;
use opensesame_domain::{ExecutionTarget, ProviderDefinition};
use opensesame_transport_security::plain_provenance_layer;

use routes::{WorkerAuth, WorkerState};
use transport::WorkerTransport;

/// The plain listener's id, for provenance on the `existing_local` profile.
const WORKER_PLAIN_LISTENER: &str = "worker-plain";

/// Flags for `opensesame worker run`.
#[derive(Parser, Debug)]
#[command(about = "Run the workload connector host")]
pub struct Args {
    #[arg(long, default_value = "worker-1")]
    id: String,
    #[arg(
        long,
        env = "OPENSESAME_WORKER_LISTEN",
        default_value = "127.0.0.1:8790"
    )]
    listen: String,
    /// Comma-separated provider ids this workload is authorized to host.
    #[arg(
        long,
        env = "OPENSESAME_WORKER_PROVIDERS",
        value_delimiter = ',',
        required = true
    )]
    providers: Vec<String>,
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Serve the workload connector host until its listener stops.
///
/// # Errors
///
/// Fails when a provider is unknown or personal-only, the transport profile
/// is invalid, or a `mtls_required` identity cannot be loaded or bound.
pub async fn run(args: Args) -> anyhow::Result<()> {
    let configured = configured_providers(&args.providers)?;
    let profile = WorkerTransport::parse(&process_env).map_err(anyhow::Error::new)?;
    match profile {
        WorkerTransport::ExistingLocal => serve_local(&args, configured).await,
        WorkerTransport::MtlsRequired => serve_mtls(&args, configured).await,
    }
}

/// The deliberate local compatibility profile.
async fn serve_local(args: &Args, configured: Vec<ProviderDefinition>) -> anyhow::Result<()> {
    let operator_token = std::env::var("OPENSESAME_WORKER_TOKEN")
        .or_else(|_| std::env::var("OPENSESAME_OPERATOR_TOKEN"))
        .unwrap_or_default();
    let state = WorkerState::new(configured, WorkerAuth::Token(operator_token));
    let app = routes::router(state).layer(plain_provenance_layer(WORKER_PLAIN_LISTENER));
    let listener = tokio::net::TcpListener::bind(&args.listen).await?;
    tracing::info!(worker_id=%args.id, listen=%args.listen, profile="existing_local", "workload connector host ready");
    axum::serve(listener, app).await?;
    Ok(())
}

/// The networked workload-identity profile. No token is read here, so a
/// refused certificate has nothing weaker to fall back to; a missing or
/// unusable identity, trust bundle or bindings file exits non-zero.
async fn serve_mtls(args: &Args, configured: Vec<ProviderDefinition>) -> anyhow::Result<()> {
    let profile = transport::load(&args.listen, &process_env).map_err(|error| {
        anyhow::anyhow!(
            "worker mtls_required refused to start: {error} [{}]",
            error.code()
        )
    })?;
    let state = WorkerState::new(
        configured,
        WorkerAuth::Mtls {
            bindings: std::sync::Arc::clone(&profile.bindings),
            generations: std::sync::Arc::clone(&profile.generations),
        },
    );
    let listener = transport::bind(&profile).await.map_err(|error| {
        anyhow::anyhow!(
            "worker mtls_required refused to start: {error} [{}]",
            error.code()
        )
    })?;
    let app = routes::router(state).layer(axum::middleware::from_fn_with_state(
        std::sync::Arc::clone(&profile.generations),
        opensesame_transport_security::enforce_current_generation,
    ));
    tracing::info!(worker_id=%args.id, listen=%listener.local_addr(), profile="mtls_required", "workload connector host ready");
    listener.serve(app).await.map_err(anyhow::Error::new)?;
    Ok(())
}

fn configured_providers(ids: &[String]) -> anyhow::Result<Vec<ProviderDefinition>> {
    ids.iter()
        .map(|id| {
            let provider =
                providers::find(id).ok_or_else(|| anyhow::anyhow!("unknown provider {id}"))?;
            if !provider
                .execution_targets
                .contains(&ExecutionTarget::WorkloadWorker)
            {
                anyhow::bail!("provider {id} is personal-only and cannot run in a workload worker");
            }
            Ok(provider)
        })
        .collect()
}
