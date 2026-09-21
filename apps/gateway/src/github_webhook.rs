//! Verified GitHub App webhooks → durable outbox → `TaskBus` wake.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::github_webhook_hmac::verify_hub_signature_256;
use opensesame_task_bus::BusEvent;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app_state::AppState;

const WEBHOOK_EVENT: &str = "github.webhook";
const WAKE_TYPE: &str = "system.github.webhook.wake";

fn well_formed_hub_signature(signature: &str) -> bool {
    let Some(hex) = signature
        .strip_prefix("sha256=")
        .or_else(|| signature.strip_prefix("SHA256="))
    else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn body_claim_key(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    format!("github.body.{digest:x}")
}

fn webhook_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

async fn configured_webhook_secret(st: &AppState) -> Result<String, Response> {
    let org = st.connection_organization;
    let integrations = st
        .connection_broker
        .list_integrations(&org)
        .await
        .map_err(|_| webhook_error(StatusCode::SERVICE_UNAVAILABLE, "integrations_unavailable"))?;
    let Some(integration) = integrations.iter().find(|row| {
        row.provider_id == "github"
            && row.enabled
            && row.source == opensesame_connection_broker::IntegrationSource::Organization
    }) else {
        return Err(webhook_error(
            StatusCode::NOT_FOUND,
            "github_app_not_configured",
        ));
    };
    match st
        .connection_broker
        .github_webhook_secret(&org, &integration.id)
        .await
    {
        Ok(Some(secret)) if !secret.is_empty() => Ok(secret),
        Ok(_) => Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"webhook_secret_missing","hint":"recreate GitHub App with webhook secret"})),
        )
            .into_response()),
        Err(_) => Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
    }
}

async fn claim_webhook_body(st: &AppState, body: &[u8]) -> Result<Option<String>, Response> {
    let claim_key = body_claim_key(body);
    match st.db.try_claim_host_kv(&claim_key, "pending").await {
        Ok(true) => Ok(Some(claim_key)),
        Ok(false) => Ok(None),
        Err(error) => {
            tracing::error!(%error, "webhook delivery claim failed");
            Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))
        }
    }
}

async fn append_webhook_outbox(
    st: &AppState,
    claim_key: &str,
    payload: &Value,
) -> Result<String, Response> {
    match st
        .db
        .append_outbox(WEBHOOK_EVENT, &payload.to_string())
        .await
    {
        Ok(id) => Ok(id),
        Err(error) => {
            tracing::error!(%error, "webhook outbox append failed");
            if let Err(release) = st.db.delete_host_kv(claim_key).await {
                tracing::error!(%release, "webhook claim rollback failed");
            }
            Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))
        }
    }
}

/// `POST /api/v1/webhooks/github` — verify, enqueue, wake. Fast 2xx after durable write.
pub async fn webhook(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // Fail closed on a missing/malformed MAC before any DB or secret lookup.
    if !well_formed_hub_signature(signature) {
        return webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature");
    }

    let delivery = headers
        .get("x-github-delivery")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let event_name = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let secret = match configured_webhook_secret(&st).await {
        Ok(secret) => secret,
        Err(response) => return response,
    };

    if !verify_hub_signature_256(&secret, &body, signature) {
        return webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature");
    }

    if delivery.is_empty() {
        return webhook_error(StatusCode::BAD_REQUEST, "missing_delivery_id");
    }

    // HMAC covers the body, not x-github-delivery. Dedup on the verified body
    // so an attacker cannot replay the same payload under a fresh delivery id.
    let claim_key = match claim_webhook_body(&st, &body).await {
        Ok(Some(claim_key)) => claim_key,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(response) => return response,
    };

    let payload: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let installation_id = payload
        .pointer("/installation/id")
        .and_then(serde_json::Value::as_u64)
        .map(|n| n.to_string());

    let organization = st.connection_organization.to_string();
    let mut outbox_payload = json!({
        "delivery_id": delivery,
        "event": event_name,
        "action": action,
        "installation_id": installation_id,
    });
    // Bind the tenant when a backup target matches this installation so the
    // backup actor can consume the webhook as a sync trigger (ADR 0039).
    if let Ok(Some(target)) = st.db.get_backup_target(&organization).await {
        let installation_matches = installation_id
            .as_deref()
            .is_none_or(|id| target.installation_id.is_empty() || target.installation_id == id);
        if installation_matches {
            outbox_payload["organization_id"] = json!(organization);
        }
    }

    let outbox_id = match append_webhook_outbox(&st, &claim_key, &outbox_payload).await {
        Ok(id) => id,
        Err(response) => return response,
    };

    let _ = st.db.set_host_kv(&claim_key, &outbox_id).await;

    apply_installation_side_effects(&st, &event_name, &action, installation_id.as_deref()).await;

    publish_webhook_wake(&st, &outbox_id, &delivery).await;
    st.backup_notify.notify_one();

    StatusCode::NO_CONTENT.into_response()
}

async fn apply_installation_side_effects(
    st: &AppState,
    event: &str,
    action: &str,
    installation_id: Option<&str>,
) {
    let org = st.connection_organization.to_string();
    let Ok(Some(mut target)) = st.db.get_backup_target(&org).await else {
        return;
    };
    if let Some(id) = installation_id {
        if !target.installation_id.is_empty() && target.installation_id != id {
            return;
        }
    }
    match (event, action) {
        ("installation", "deleted" | "suspend") => {
            let _ = st
                .db
                .record_backup_outcome(&org, "suspended", None, Some("github_app_uninstalled"))
                .await;
        }
        ("installation", "unsuspend" | "created" | "new_permissions_accepted") => {
            target.status = "pending".into();
            target.last_error = None;
            let _ = st.db.upsert_backup_target(&target).await;
        }
        _ => {}
    }
}

async fn publish_webhook_wake(st: &AppState, outbox_id: &str, delivery_id: &str) {
    let event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        "opensesame/gateway/github-webhook",
        WAKE_TYPE,
        chrono::Utc::now().to_rfc3339(),
        json!({
            "outbox_id": outbox_id,
            "delivery_id": delivery_id,
        }),
    );
    let bus = st.task_bus.read().await;
    if let Err(error) = bus.publish(event).await {
        tracing::warn!(%error, "github webhook TaskBus wake failed");
    }
}

/// GET health for webhook endpoint (GitHub ping may use GET in some setups).
pub async fn webhook_get() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
#[path = "github_webhook_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "github_webhook_tests_more.rs"]
mod tests_more;
