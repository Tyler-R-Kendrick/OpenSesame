//! Tenant GitHub App Manifest registration (organization integration).

use std::fmt::Write;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    Json,
};
use opensesame_connection_broker::{
    build_manifest, convert_manifest_code, GithubAppCredentials, GITHUB_APP_REGISTER_URL,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::app_state::{AppState, GithubAppPending};
use crate::middleware::auth::{resolve_caller, Caller};

fn pending_map(st: &AppState) -> std::sync::MutexGuard<'_, HashMap<String, GithubAppPending>> {
    st.github_app_pending.lock().expect("github_app_pending")
}

fn prune(map: &mut HashMap<String, GithubAppPending>) {
    let now = Instant::now();
    map.retain(|_, pending| pending.expires_at > now);
}

fn new_state() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

fn allow_return_to(st: &AppState, return_to: &str) -> bool {
    st.connection_broker.config().return_to_allowed(return_to)
}

fn manifest_callback_url(st: &AppState) -> String {
    format!(
        "{}/api/v1/oauth/github-app/callback",
        st.connection_broker.config().public_url()
    )
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterBody {
    pub return_to: Option<String>,
    pub display_name: Option<String>,
}

fn parse_register_body(body: &str) -> Result<RegisterBody, Response> {
    if body.trim().is_empty() {
        return Ok(RegisterBody::default());
    }
    serde_json::from_str(body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"request body is not valid JSON"})),
        )
            .into_response()
    })
}

/// Start the GitHub App Manifest flow for this organization.
pub async fn register_start(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Response {
    let who = match resolve_caller(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if !who.can_configure_integrations() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"forbidden","hint":"owner or admin role required to deploy a GitHub App"})),
        )
            .into_response();
    }
    let body = match parse_register_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let organization_id = match who {
        Caller::Operator => st.connection_organization,
        Caller::Session {
            organization_id, ..
        } => organization_id,
    };
    let return_to = body
        .return_to
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:5180/connections/github".into());
    if !allow_return_to(&st, &return_to) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"return_to is not an allowed Pages origin"})),
        )
            .into_response();
    }
    let created_by = match &who {
        Caller::Operator => "operator".into(),
        Caller::Session { subject, .. } => subject.clone(),
    };
    let state = new_state();
    let display_name = body
        .display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let id = organization_id.to_string();
            let suffix = id.rsplit(':').next().unwrap_or(&id);
            let short: String = suffix.chars().take(8).collect();
            format!("OpenSesame {short}")
        });
    let redirect_url = manifest_callback_url(&st);
    // Install completion must land on Pages — not the Manifest conversion
    // callback (that endpoint requires our one-time `state`).
    let setup_url = {
        let sep = if return_to.contains('?') { '&' } else { '?' };
        format!("{return_to}{sep}github_app=installed")
    };
    let manifest = build_manifest(
        st.connection_broker.config(),
        &display_name,
        &redirect_url,
        &setup_url,
    );
    {
        let mut map = pending_map(&st);
        prune(&mut map);
        if map.len() >= 256 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(
                    json!({"error":"capacity","hint":"too many pending GitHub App registrations"}),
                ),
            )
                .into_response();
        }
        map.insert(
            state.clone(),
            GithubAppPending {
                organization_id,
                created_by,
                return_to,
                expires_at: Instant::now() + Duration::from_secs(3600),
            },
        );
    }
    Json(json!({
        "action": GITHUB_APP_REGISTER_URL,
        "state": state,
        "manifest": manifest,
        "redirect_url": redirect_url,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

fn registration_failure(return_to: Option<String>, reason: &str) -> Response {
    let base = return_to.unwrap_or_else(|| "http://127.0.0.1:5180/connections/github".into());
    let sep = if base.contains('?') { '&' } else { '?' };
    Redirect::temporary(&format!(
        "{base}{sep}github_app=error&reason={}",
        urlencoding_encode(reason)
    ))
    .into_response()
}

fn callback_codes(query: CallbackQuery) -> Result<(String, String), Response> {
    if let Some(error) = query.error.as_deref().filter(|value| !value.is_empty()) {
        let detail = query
            .error_description
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(error);
        return Err(registration_failure(None, detail));
    }
    let state = query
        .state
        .filter(|value| !value.is_empty())
        .ok_or_else(|| registration_failure(None, "missing_state"))?;
    let code = query
        .code
        .filter(|value| !value.is_empty())
        .ok_or_else(|| registration_failure(None, "missing_code"))?;
    Ok((state, code))
}

fn take_pending_registration(st: &AppState, state: &str) -> Result<GithubAppPending, Response> {
    let pending = {
        let mut map = pending_map(st);
        prune(&mut map);
        map.remove(state)
    }
    .ok_or_else(|| registration_failure(None, "unknown_or_expired_state"))?;
    if Instant::now() > pending.expires_at {
        return Err(registration_failure(
            Some(pending.return_to),
            "expired_state",
        ));
    }
    Ok(pending)
}

fn registration_success(return_to: &str, integration_id: &str) -> Response {
    let sep = if return_to.contains('?') { '&' } else { '?' };
    Redirect::temporary(&format!(
        "{return_to}{sep}github_app=registered&integration={}",
        urlencoding_encode(integration_id)
    ))
    .into_response()
}

async fn exchange_manifest_code(st: &AppState, code: &str) -> Option<GithubAppCredentials> {
    match convert_manifest_code(st.connection_broker.http_client(), code).await {
        Ok(credentials) => Some(credentials),
        Err(error) => {
            tracing::warn!(%error, "github app manifest conversion failed");
            None
        }
    }
}

async fn complete_registration(st: &AppState, pending: GithubAppPending, code: &str) -> Response {
    let Some(credentials) = exchange_manifest_code(st, code).await else {
        return registration_failure(Some(pending.return_to), "conversion_failed");
    };
    match st
        .connection_broker
        .register_github_app_credentials(
            &pending.organization_id,
            &credentials,
            &pending.created_by,
        )
        .await
    {
        Ok(integration) => {
            tracing::info!(
                integration_id = %integration.id,
                organization_id = %pending.organization_id,
                "github app registered as organization integration"
            );
            registration_success(&pending.return_to, &integration.id)
        }
        Err(error) => {
            tracing::warn!(%error, "failed to seal github app credentials");
            registration_failure(Some(pending.return_to), error.code())
        }
    }
}

/// GitHub redirects here after the operator creates the app from the manifest.
pub async fn register_callback(
    State(st): State<AppState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let (state, code) = match callback_codes(query) {
        Ok(codes) => codes,
        Err(response) => return response,
    };
    let pending = match take_pending_registration(&st, &state) {
        Ok(pending) => pending,
        Err(response) => return response,
    };

    complete_registration(&st, pending, &code).await
}

fn urlencoding_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => write!(out, "%{byte:02X}").expect("writing to String cannot fail"),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_callback_codes_require_the_exact_success_pair() {
        let (state, code) = callback_codes(CallbackQuery {
            code: Some("code-1".into()),
            state: Some("state-1".into()),
            error: None,
            error_description: None,
        })
        .unwrap();
        assert_eq!((state.as_str(), code.as_str()), ("state-1", "code-1"));

        assert!(callback_codes(CallbackQuery {
            code: Some("code-1".into()),
            state: None,
            error: None,
            error_description: None,
        })
        .is_err());
        assert!(callback_codes(CallbackQuery {
            code: Some("code-1".into()),
            state: Some("state-1".into()),
            error: Some("denied".into()),
            error_description: Some("operator denied".into()),
        })
        .is_err());
    }
}
