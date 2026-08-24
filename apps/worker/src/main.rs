//! Explicitly configured workload connector host.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use clap::Parser;
use opensesame_connector_host::providers::{self, ProviderProbe};
use opensesame_domain::{ExecutionTarget, ProviderDefinition};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    providers: Arc<Vec<ProviderDefinition>>,
    operator_token: String,
    #[allow(clippy::type_complexity)]
    // A single timestamped cache does not warrant a wrapper type.
    last_probe: Arc<Mutex<Option<(Instant, Vec<ProviderProbe>)>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let configured = configured_providers(&args.providers)?;
    let operator_token = std::env::var("OPENSESAME_WORKER_TOKEN")
        .or_else(|_| std::env::var("OPENSESAME_OPERATOR_TOKEN"))
        .unwrap_or_default();
    let state = WorkerState {
        providers: Arc::new(configured),
        operator_token,
        last_probe: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/providers", get(list_providers))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&args.listen).await?;
    tracing::info!(worker_id=%args.id, listen=%args.listen, "workload connector host ready");
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

async fn live() -> Json<serde_json::Value> {
    Json(json!({"ok": true}))
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn require_worker_token(state: &WorkerState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if state.operator_token.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let presented = headers
        .get("x-opensesame-operator")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|v| v.trim_start_matches("operator:").to_string())
        });
    match presented {
        Some(token) if constant_time_eq(&token, &state.operator_token) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn ready(
    State(state): State<WorkerState>,
    headers: HeaderMap,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_worker_token(&state, &headers) {
        return (status, Json(json!({"ok": false})));
    }
    let cached = {
        let guard = state
            .last_probe
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(10))
            .map(|(_, probes)| probes.clone())
    };
    let probes = if let Some(probes) = cached {
        probes
    } else {
        let configured = state.providers.clone();
        match tokio::task::spawn_blocking(move || {
            configured
                .iter()
                .map(providers::probe_live)
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(probes) => {
                *state
                    .last_probe
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some((Instant::now(), probes.clone()));
                probes
            }
            Err(_) => {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok": false})));
            }
        }
    };
    let available = probes.iter().all(|probe| probe.available);
    (
        if available {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "ok": available })),
    )
}

async fn list_providers(
    State(state): State<WorkerState>,
    headers: HeaderMap,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_worker_token(&state, &headers) {
        return (status, Json(json!({"error": "unauthorized"})));
    }
    (
        StatusCode::OK,
        Json(
            json!({"providers": state.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>()}),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_state(token: &str) -> WorkerState {
        WorkerState {
            providers: Arc::new(vec![]),
            operator_token: token.into(),
            last_probe: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn workload_configuration_rejects_personal_only_providers() {
        assert!(configured_providers(&["aws-secrets-manager".into()]).is_ok());
        assert!(configured_providers(&["1password".into()]).is_err());
        assert!(configured_providers(&["does-not-exist".into()]).is_err());
    }

    #[test]
    fn operator_compare_is_length_hiding() {
        let src = include_str!("main.rs");
        let production = src.split("#[cfg(test)]").next().expect("production");
        assert!(production.contains("fn constant_time_eq"));
        assert!(production.contains("constant_time_eq(&token, &state.operator_token)"));
        assert!(!production.contains("token == state.operator_token"));
        let token_fn = production
            .split("fn require_worker_token")
            .nth(1)
            .expect("require_worker_token");
        let token_fn = token_fn.split("async fn ready").next().expect("ready");
        assert!(token_fn.contains("constant_time_eq"));
        let ready = production.split("async fn ready").nth(1).expect("ready fn");
        let ready = ready.split("async fn list_providers").next().expect("list");
        assert!(ready.contains("spawn_blocking"));
        assert!(ready.contains("SERVICE_UNAVAILABLE"));
    }

    #[test]
    fn worker_token_fail_closed() {
        let empty = dummy_state("");
        assert_eq!(
            require_worker_token(&empty, &HeaderMap::new()),
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );

        let state = dummy_state("secret-token");
        assert_eq!(
            require_worker_token(&state, &HeaderMap::new()),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut wrong = HeaderMap::new();
        wrong.insert("x-opensesame-operator", "nope".parse().unwrap());
        assert_eq!(
            require_worker_token(&state, &wrong),
            Err(StatusCode::UNAUTHORIZED)
        );

        let mut right = HeaderMap::new();
        right.insert("x-opensesame-operator", "secret-token".parse().unwrap());
        assert!(require_worker_token(&state, &right).is_ok());
    }
}
