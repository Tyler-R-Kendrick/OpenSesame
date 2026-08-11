//! Explicitly configured workload connector host.
use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use clap::Parser;
use opensesame_connector_host::providers::{self, ProviderProbe};
use opensesame_domain::{ExecutionTarget, ProviderDefinition};
use serde_json::json;
use std::sync::Arc;

#[derive(Parser)]
struct Args {
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

#[derive(Clone)]
struct WorkerState {
    id: String,
    providers: Arc<Vec<ProviderDefinition>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let configured = configured_providers(&args.providers)?;
    let state = WorkerState {
        id: args.id,
        providers: Arc::new(configured),
    };
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/providers", get(list_providers))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&args.listen).await?;
    tracing::info!(listen=%args.listen, "workload connector host ready");
    axum::serve(listener, app).await?;
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

async fn live(State(state): State<WorkerState>) -> Json<serde_json::Value> {
    Json(json!({"status": "live", "worker_id": state.id}))
}

async fn ready(State(state): State<WorkerState>) -> (StatusCode, Json<serde_json::Value>) {
    let configured = state.providers.clone();
    let probes: Vec<ProviderProbe> = match tokio::task::spawn_blocking(move || {
        configured.iter().map(providers::probe_live).collect()
    })
    .await
    {
        Ok(probes) => probes,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "not_ready", "worker_id": state.id})),
            );
        }
    };
    let available = probes.iter().all(|probe| probe.available);
    (
        if available {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({
            "status": if available { "ready" } else { "not_ready" },
            "worker_id": state.id,
            "probes": probes,
        })),
    )
}

async fn list_providers(State(state): State<WorkerState>) -> Json<serde_json::Value> {
    Json(json!({"providers": state.providers.as_ref()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_configuration_rejects_personal_only_providers() {
        assert!(configured_providers(&["aws-secrets-manager".into()]).is_ok());
        assert!(configured_providers(&["1password".into()]).is_err());
        assert!(configured_providers(&["does-not-exist".into()]).is_err());
    }
}
