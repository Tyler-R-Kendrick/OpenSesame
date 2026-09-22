//! The worker's HTTP surface and the authorization in front of it.
//!
//! `/health/live` is a deliberately minimal, non-sensitive liveness answer in
//! its own health profile: it names no provider, reveals no configuration,
//! and is the one route the enforcement probe asks for. It is *not* a
//! plaintext alternate path to the service handlers — everything else is
//! admitted first.
//!
//! `/health/ready` and `/v1/providers` are service-only operations
//! (`worker.health.ready`, `worker.providers.list`). Under `mtls_required`
//! they are authorized by the verified peer's explicit service binding and by
//! nothing else; the provider probe runs only *after* that admission, so an
//! unauthorized caller can never make this worker touch a provider.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use opensesame_connector_host::providers::{self, ProviderProbe};
use opensesame_domain::transport::{
    operations, BindingPurpose, BindingScope, ServiceBindingSet, ServiceCaller, TransportError,
};
use opensesame_domain::ProviderDefinition;
use opensesame_transport_security::guard::deny_response;
use opensesame_transport_security::{PeerExtension, TransportGenerations};
use serde_json::json;

/// How the worker authorizes a service call. Exactly one is in force.
#[derive(Clone)]
pub enum WorkerAuth {
    /// `existing_local`: the deliberate loopback compatibility profile.
    Token(String),
    /// `mtls_required`: bindings only. This variant holds no token, so there
    /// is nothing for a refused certificate to fall back to.
    Mtls {
        bindings: Arc<ServiceBindingSet>,
        generations: Arc<TransportGenerations>,
    },
}

#[derive(Clone)]
pub struct WorkerState {
    pub providers: Arc<Vec<ProviderDefinition>>,
    pub auth: WorkerAuth,
    #[allow(clippy::type_complexity)]
    // A single timestamped cache does not warrant a wrapper type.
    pub last_probe: Arc<Mutex<Option<(Instant, Vec<ProviderProbe>)>>>,
}

impl WorkerState {
    #[must_use]
    pub fn new(providers: Vec<ProviderDefinition>, auth: WorkerAuth) -> Self {
        Self {
            providers: Arc::new(providers),
            auth,
            last_probe: Arc::new(Mutex::new(None)),
        }
    }
}

#[must_use]
pub fn router(state: WorkerState) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/providers", get(list_providers))
        .with_state(state)
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

/// The `existing_local` credential check, unchanged.
///
/// # Errors
/// `SERVICE_UNAVAILABLE` when no token is provisioned, `UNAUTHORIZED` otherwise.
pub fn require_worker_token(token: &str, headers: &HeaderMap) -> Result<(), StatusCode> {
    if token.is_empty() {
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
        Some(presented) if constant_time_eq(&presented, token) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Admit one service operation.
///
/// # Errors
/// The profile's own refusal response.
#[allow(clippy::result_large_err)]
pub fn admit(
    state: &WorkerState,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
    operation: &str,
) -> Result<Option<ServiceCaller>, Response> {
    match &state.auth {
        WorkerAuth::Token(token) => require_worker_token(token, headers)
            .map(|()| None)
            .map_err(|status| (status, Json(json!({"ok": false}))).into_response()),
        WorkerAuth::Mtls {
            bindings,
            generations,
        } => {
            let Some(PeerExtension(peer)) = extensions.get::<PeerExtension>() else {
                return Err(deny_response(&TransportError::ListenerPolicyMismatch));
            };
            let current = generations.current().number;
            let caller = ServiceCaller::admit(
                (**peer).clone(),
                &BindingScope::Deployment,
                bindings,
                BindingPurpose::WorkerClient,
                current,
                current,
                chrono::Utc::now(),
            )
            .map_err(|error| deny_response(&error))?;
            caller
                .require_operation(operation)
                .map_err(|error| deny_response(&error))?;
            Ok(Some(caller))
        }
    }
}

async fn ready(
    State(state): State<WorkerState>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Response {
    if let Err(response) = admit(
        &state,
        &headers,
        request.extensions(),
        operations::WORKER_HEALTH_READY,
    ) {
        return response;
    }
    // Providers are probed only after admission.
    let probes = match probe_providers(&state).await {
        Some(probes) => probes,
        None => {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok": false}))).into_response()
        }
    };
    let available = probes.iter().all(|probe| probe.available);
    let status = if available {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(json!({ "ok": available }))).into_response()
}

async fn probe_providers(state: &WorkerState) -> Option<Vec<ProviderProbe>> {
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
    if let Some(probes) = cached {
        return Some(probes);
    }
    let configured = Arc::clone(&state.providers);
    let probes = tokio::task::spawn_blocking(move || {
        configured
            .iter()
            .map(providers::probe_live)
            .collect::<Vec<_>>()
    })
    .await
    .ok()?;
    *state
        .last_probe
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((Instant::now(), probes.clone()));
    Some(probes)
}

async fn list_providers(
    State(state): State<WorkerState>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Response {
    if let Err(response) = admit(
        &state,
        &headers,
        request.extensions(),
        operations::WORKER_PROVIDERS_LIST,
    ) {
        return response;
    }
    (
        StatusCode::OK,
        Json(json!({
            "providers": state.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>()
        })),
    )
        .into_response()
}
