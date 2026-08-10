//! Connection lifecycle routes (ADR 0032, `docs/architecture/connection-broker.md`).
//!
//! Responses carry a `ConnectionRef`, status and bindings. No route here returns
//! an access token, a refresh token, a code verifier or a client secret, and the
//! shapes the broker hands back have nowhere to put one.

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{
    parse_shareability, BindRequest, BindingTargetKind, BrokerError, CreateConnection,
    MAX_CREDENTIAL_BYTES,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, Caller};

#[allow(clippy::result_large_err)]
fn authorize(st: &AppState, headers: &axum::http::HeaderMap) -> Result<Caller, Response> {
    resolve_caller(st, headers)
}

fn caller_subject(who: &Caller) -> Option<String> {
    match who {
        Caller::Operator => None,
        Caller::Principal(id) => Some(id.to_string()),
        Caller::Unbound => Some(String::new()),
    }
}

fn caller_owns(who: &Caller, owner: Option<&String>) -> bool {
    match who {
        Caller::Operator => true,
        Caller::Principal(id) => owner.is_some_and(|owner| owner == &id.to_string()),
        Caller::Unbound => false,
    }
}

/// A connection belonging to someone else reads as absent, so ids cannot be probed.
/// The organization is not the boundary here: one gateway serves many callers out
/// of a single org, so who created a connection is what decides who may use it.
async fn owned(st: &AppState, who: &Caller, id: &str) -> Result<(), Response> {
    match st
        .connection_broker
        .owner_subject(&st.connection_organization, id)
        .await
    {
        Ok(owner) if caller_owns(who, owner.as_ref()) => Ok(()),
        Ok(_) => Err(broker_error(BrokerError::ConnectionNotFound)),
        Err(e) => Err(broker_error(e)),
    }
}

fn broker_error(e: BrokerError) -> Response {
    let status = StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if matches!(e, BrokerError::Storage(_) | BrokerError::Serde(_)) {
        tracing::error!(error = %e, "connection broker storage failure");
    }
    (status, Json(json!({"error": e.code(), "hint": e.hint()}))).into_response()
}

/// Bodies are read as text so an absent one is the same as `{}` — several of
/// these routes take no required field.
#[allow(clippy::result_large_err)]
fn parse_body<T: serde::de::DeserializeOwned + Default>(raw: &str) -> Result<T, Response> {
    if raw.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(raw).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"request body is not valid JSON"})),
        )
            .into_response()
    })
}

pub async fn list_providers(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&st, &headers) {
        return resp;
    }
    Json(json!({"providers": st.connection_broker.list_providers()})).into_response()
}

/// The agent surface: `connection_ref` only, never a credential handle. Only real
/// rows appear. A demo bootstrap entry used to stand in when the list was empty,
/// but it named no row: every per-id route answered `connection_not_found` for it,
/// and it was too thin to parse as a connection. An empty list is the honest answer,
/// and now also the private one — a session's list is its own.
pub async fn list(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    // An operator sees the whole org; a session sees what it created.
    let mine = caller_subject(&who);
    let stored = match st
        .connection_broker
        .list_connections_for(&st.connection_organization, mine.as_deref())
        .await
    {
        Ok(c) => c,
        Err(e) => return broker_error(e),
    };
    Json(json!({"connections": stored})).into_response()
}

#[derive(Default, Deserialize)]
pub struct CreateBody {
    pub provider_id: String,
    pub display_name: Option<String>,
    pub logical_name: Option<String>,
    pub project_id: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub shareability: Option<String>,
}

pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let body: CreateBody = match parse_body(&body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    if body.provider_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"provider_id is required"})),
        )
            .into_response();
    }
    let request = CreateConnection {
        provider_id: body.provider_id.trim().to_string(),
        display_name: body.display_name,
        logical_name: body.logical_name,
        project_id: body.project_id,
        scopes: body.scopes,
        shareability: body.shareability.as_deref().map(parse_shareability),
        // From the transport, never the body: a caller does not get to say whose
        // connection this is.
        owner_subject: caller_subject(&who),
    };
    match st
        .connection_broker
        .create_connection(&st.connection_organization, request)
        .await
    {
        Ok(view) => (StatusCode::CREATED, Json(view)).into_response(),
        Err(e) => broker_error(e),
    }
}

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    match st
        .connection_broker
        .get_connection(&st.connection_organization, &id)
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(e) => broker_error(e),
    }
}

pub async fn delete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    match st
        .connection_broker
        .revoke(&st.connection_organization, &id)
        .await
    {
        Ok(outcome) => Json(outcome).into_response(),
        Err(e) => broker_error(e),
    }
}

#[derive(Default, Deserialize)]
pub struct AuthorizeBody {
    pub redirect_uri: Option<String>,
    pub scopes: Option<Vec<String>>,
}

pub async fn start_authorization(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    let body: AuthorizeBody = match parse_body(&body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .start_authorization(
            &st.connection_organization,
            &id,
            body.redirect_uri,
            body.scopes,
        )
        .await
    {
        Ok(start) => Json(start).into_response(),
        Err(e) => broker_error(e),
    }
}

pub async fn refresh(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    match st
        .connection_broker
        .refresh(&st.connection_organization, &id)
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(e) => broker_error(e),
    }
}

#[derive(Default, Deserialize)]
pub struct CredentialBody {
    pub value: String,
}

pub async fn set_credential(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    // Refused before parsing: a credential is a key, so a body far larger than one
    // is not worth deserializing, let alone sealing into the shared store.
    if body.len() > MAX_CREDENTIAL_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "credential_too_large",
                "detail": {"limit_bytes": MAX_CREDENTIAL_BYTES, "received_bytes": body.len()}
            })),
        )
            .into_response();
    }
    let body: CredentialBody = match parse_body(&body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .set_api_key(&st.connection_organization, &id, &body.value)
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(e) => broker_error(e),
    }
}

#[derive(Default, Deserialize)]
pub struct BindBody {
    pub target_kind: String,
    pub target_id: String,
    pub target_label: Option<String>,
}

pub async fn create_binding(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    let body: BindBody = match parse_body(&body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let Some(target_kind) = BindingTargetKind::parse(body.target_kind.trim()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error":"invalid_request",
                "hint":"target_kind must be organization, project or agent"
            })),
        )
            .into_response();
    };
    match st
        .connection_broker
        .bind(
            &st.connection_organization,
            &id,
            BindRequest {
                target_kind,
                target_id: body.target_id,
                target_label: body.target_label,
            },
        )
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(e) => broker_error(e),
    }
}

pub async fn delete_binding(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, binding_id)): Path<(String, String)>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    match st
        .connection_broker
        .unbind(&st.connection_organization, &id, &binding_id)
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(e) => broker_error(e),
    }
}

pub async fn events(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    if let Err(resp) = owned(&st, &who, &id).await {
        return resp;
    }
    match st
        .connection_broker
        .events(&st.connection_organization, &id)
        .await
    {
        Ok(events) => Json(json!({"events": events})).into_response(),
        Err(e) => broker_error(e),
    }
}

/// The one unauthenticated route: the caller is the provider's redirect, and the
/// single-use `state` is what authenticates it.
pub async fn oauth_callback(
    State(st): State<AppState>,
    Path(provider_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Some(error) = params.get("error") {
        let detail = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone());
        return callback_page(CallbackOutcome::Failed {
            code: error.clone(),
            hint: detail,
        });
    }
    let (Some(code), Some(state)) = (params.get("code"), params.get("state")) else {
        return callback_page(CallbackOutcome::Failed {
            code: "invalid_request".into(),
            hint: "the provider redirect carried no code and state".into(),
        });
    };

    match st
        .connection_broker
        .complete_authorization(&provider_id, code, state)
        .await
    {
        Ok(view) => callback_page(CallbackOutcome::Completed {
            connection_id: view.connection_id,
            status: view.status.as_str().to_string(),
        }),
        Err(e) => callback_page(CallbackOutcome::Failed {
            code: e.code().to_string(),
            hint: e.hint(),
        }),
    }
}

enum CallbackOutcome {
    Completed {
        connection_id: String,
        status: String,
    },
    Failed {
        code: String,
        hint: String,
    },
}

/// Everything interpolated is HTML-escaped, and the message payload travels as an
/// escaped attribute rather than as inlined script source, so no provider-supplied
/// string can close the tag it sits in.
fn callback_page(outcome: CallbackOutcome) -> Response {
    let (payload, heading, detail, status_code) = match outcome {
        CallbackOutcome::Completed {
            connection_id,
            status,
        } => (
            json!({"type":"opensesame:connection","connectionId":connection_id,"status":status}),
            "Connected".to_string(),
            "You can close this window.".to_string(),
            StatusCode::OK,
        ),
        CallbackOutcome::Failed { code, hint } => (
            json!({"type":"opensesame:connection","error":code,"hint":hint}),
            "Connection failed".to_string(),
            format!("{code}: {hint}"),
            StatusCode::BAD_REQUEST,
        ),
    };
    let payload = escape_html(&payload.to_string());
    let heading = escape_html(&heading);
    let detail = escape_html(&detail);

    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{heading}</title></head>
<body style="font:14px system-ui;margin:2rem">
<h1>{heading}</h1>
<p>{detail}</p>
<div id="opensesame-payload" data-payload="{payload}" hidden></div>
<script>
(function () {{
  var el = document.getElementById("opensesame-payload");
  var message = JSON.parse(el.dataset.payload);
  if (window.opener) {{
    window.opener.postMessage(message, "*");
    window.close();
  }}
}})();
</script>
</body>
</html>"#
    );

    (
        status_code,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

fn escape_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            '/' => out.push_str("&#x2f;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests;
