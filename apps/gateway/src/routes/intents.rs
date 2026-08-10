use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_broker::InvokeInput;
use opensesame_domain::*;
use opensesame_provider_openbao::CredentialAuthority;
use opensesame_provider_openfga::TupleKey;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, resolve_caller, resolve_caller_subject};

#[derive(Deserialize)]
pub struct InvokeBody {
    /// Preferred agent API: ConnectionRef URI (conn://...).
    #[serde(default)]
    connection_ref: Option<String>,
    /// Legacy alias accepted as ConnectionRef logical name or URI.
    #[serde(default)]
    connection: Option<String>,
    operation: String,
    resource: String,
    audience: Option<String>,
    parameters: Option<Value>,
    idempotency_key: Option<String>,
    /// 1=typed, 2=constrained HTTP, 3=materialize (denied by default).
    #[serde(default)]
    invoke_level: Option<u8>,
    /// Present when the caller believes it is executing under task authority.
    #[serde(default)]
    task_run_id: Option<String>,
    #[serde(default)]
    intent_digest: Option<String>,
}

/// True when the caller claims task authority, in headers or body.
fn claims_task_authority(body: &InvokeBody, headers: &axum::http::HeaderMap) -> bool {
    body.task_run_id.is_some()
        || body.intent_digest.is_some()
        || headers.contains_key("x-opensesame-task-run-id")
        || headers.contains_key("x-opensesame-intent-digest")
}

pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<InvokeBody>,
) -> Response {
    // This route builds an intent from the request body, so it cannot honour a
    // task ceiling or a frozen digest. Accepting those fields anyway would let a
    // task-bound agent execute outside what it froze while looking fenced.
    if claims_task_authority(&body, &headers) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "task_authority_requires_frozen_invoke",
                "detail": "Freeze at POST /api/v1/tasks/intents, then execute at POST /api/v1/tasks/invoke",
                "type": "about:blank"
            })),
        )
            .into_response();
    }
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    if !caller.in_organization(&boot.org) {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    }
    let parameters = body.parameters.unwrap_or_else(|| json!({}));
    let default_ref = st
        .connection_ref
        .as_ref()
        .map(|c| c.handle.uri())
        .unwrap_or_default();
    let _requested_ref = body
        .connection_ref
        .clone()
        .or_else(|| body.connection.clone())
        .unwrap_or(default_ref);
    let level = body.invoke_level.unwrap_or(1);

    if level >= 3 || body.operation == "credential.resolve" || body.operation.contains("secret") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "materialize_denied",
                "detail": "Agents receive ConnectionRef, not SecretRef. Level-3 export requires raw_credential_export.",
                "type": "about:blank"
            })),
        )
            .into_response();
    }

    // Optional live OpenFGA check when configured — subject from session/operator, not a hard-coded demo user.
    if let Some(fga) = &st.openfga {
        match fga
            .check_tuple(&TupleKey {
                user: subject.clone(),
                relation: "user".into(),
                object: "connection:demo-conn".into(),
            })
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"openfga_denied","type":"about:blank"})),
                )
                    .into_response();
            }
            Err(e) => {
                // The transport error can embed the store URL and its bearer.
                tracing::warn!(error = %e, "openfga check failed");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error": "openfga_unavailable", "type":"about:blank"})),
                )
                    .into_response();
            }
        }
    }

    // Prove OpenBao path never materializes bearer to agent
    if let Some(bao) = &st.openbao {
        if let Ok(h) = bao.create_handle("github/acme").await {
            if let Err(e) = bao
                .use_credential(
                    &h,
                    opensesame_provider_openbao::CredentialOperation::BearerHttpPlaceholder,
                )
                .await
            {
                tracing::warn!(error = %e, "openbao use_credential failed (non-fatal for invoke)");
            }
        }
    }

    let param_hash = match Intent::parameters_hash(&parameters) {
        Ok(h) => h,
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            return (StatusCode::BAD_REQUEST, Json(json!({"error": msg}))).into_response();
        }
    };
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id: boot.org,
        project_id: Some(boot.project),
        principal_id: boot.principal,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(boot.connection),
        operation: body.operation,
        resource: body.resource,
        audience: body
            .audience
            .unwrap_or_else(|| "https://api.github.com".into()),
        normalized_parameters_hash: param_hash,
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: body
            .idempotency_key
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![boot.grant.id],
        proof: DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "demo".into(),
            signature: "demo".into(),
        },
    };

    match st
        .broker
        .invoke(InvokeInput {
            intent,
            grant: boot.grant.clone(),
            subject,
            connection_policy_id: "demo-conn".into(),
            parameters,
        })
        .await
    {
        Ok(receipt) => {
            let mut body = serde_json::to_value(&receipt).unwrap_or(json!({}));
            if let Some(obj) = body.as_object_mut() {
                if let Some(connection_ref) = &st.connection_ref {
                    obj.insert("connection_ref".into(), json!(connection_ref.handle.uri()));
                }
                obj.insert("invoke_level".into(), json!(level));
                obj.insert("credential_bytes_returned".into(), json!(false));
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": msg, "type": "about:blank"})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    fn body() -> InvokeBody {
        InvokeBody {
            connection_ref: None,
            connection: None,
            operation: "read".into(),
            resource: "doc:1".into(),
            audience: None,
            parameters: None,
            idempotency_key: None,
            invoke_level: None,
            task_run_id: None,
            intent_digest: None,
        }
    }

    #[test]
    fn a_plain_invoke_is_not_task_bound() {
        assert!(!claims_task_authority(&body(), &HeaderMap::new()));
    }

    #[test]
    fn task_fields_in_the_body_are_detected() {
        let mut b = body();
        b.task_run_id = Some("tsk_1".into());
        assert!(claims_task_authority(&b, &HeaderMap::new()));
        let mut b = body();
        b.intent_digest = Some("sha256:abc".into());
        assert!(claims_task_authority(&b, &HeaderMap::new()));
    }

    #[test]
    fn task_headers_cannot_smuggle_past_the_body_check() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-opensesame-intent-digest",
            HeaderValue::from_static("sha256:abc"),
        );
        assert!(claims_task_authority(&body(), &headers));
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-opensesame-task-run-id",
            HeaderValue::from_static("tsk_1"),
        );
        assert!(claims_task_authority(&body(), &headers));
    }
}
