//! `GET /v1/toolbar/status`: what the toolbar and a pairing browser are told
//! about this daemon — where its Host and Identity APIs are reachable (through
//! Tailscale Serve when it is on), and session counts. Operator-gated.
use crate::{require_operator, tailscale, App, UdsPeer};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

pub(crate) fn pairing_view(st: &App) -> Value {
    let ts = tailscale::info();
    let public = ts.https_url.as_deref().and_then(|url| {
        let trimmed = url.trim_end_matches('/');
        (!trimmed.is_empty()).then_some(trimmed)
    });
    json!({
        "host_api": public.map_or_else(|| st.host_api.clone(), |url| format!("{url}/host")),
        "identity_api": public.map_or_else(|| st.identity_api.clone(), |url| format!("{url}/identity")),
        "tailscale_url": public,
        "tailscale_serve": ts.serve_enabled,
    })
}

pub(crate) async fn toolbar_status(State(st): State<App>, uds: UdsPeer, headers: HeaderMap) -> Response {
    if let Err(resp) = require_operator(&st, &headers, &uds) {
        return resp;
    }
    let sessions = match st.sessions.lock() {
        Ok(guard) => guard.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let caps = match st.capabilities.lock() {
        Ok(guard) => guard.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut body = pairing_view(&st);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("daemon".into(), json!("ok"));
        obj.insert("sessions".into(), json!(sessions));
        obj.insert("capabilities".into(), json!(caps));
        obj.insert("materialize".into(), json!("denied_by_default"));
        obj.insert(
            "approvals".into(),
            json!(["approve_device", "approve_claim"]),
        );
        obj.insert(
            "auth".into(),
            json!("operator_token_required_for_mutations"),
        );
    }
    Json(body).into_response()
}
