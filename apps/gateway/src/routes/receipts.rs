use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::{InvocationReceipt, ReceiptId};
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

/// Loads a receipt the caller is allowed to see. Unowned ids answer 404 so the
/// endpoint is not an existence oracle for other principals' receipts.
async fn load_owned(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    id: &str,
) -> Result<InvocationReceipt, Response> {
    let caller = resolve_caller(st, headers)?;
    let Ok(rid) = ReceiptId::parse(id) else {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response());
    };
    match st.db.get_receipt(&rid).await {
        // The store resolves the authoritative organization through the
        // invocation intent, including for legacy signed receipts that did not
        // carry an organization claim themselves.
        Ok(Some(stored))
            if caller.owns(&stored.receipt.principal_id)
                && caller.in_organization(&stored.organization_id) =>
        {
            Ok(stored.receipt)
        }
        Ok(_) => Err(not_found()),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": msg})),
            )
                .into_response())
        }
    }
}

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    match load_owned(&st, &headers, &id).await {
        Ok(r) => (StatusCode::OK, Json(r)).into_response(),
        Err(resp) => resp,
    }
}

/// Public keys that may have signed a receipt.
///
/// Receipts are evidence, and evidence nobody else can check is not evidence:
/// publishing the public halves lets a holder verify a receipt without the
/// gateway's word for it. Nothing secret is exposed.
pub async fn keys(State(st): State<AppState>) -> Response {
    let keys: Vec<_> = st
        .receipt_verifier
        .published_keys()
        .into_iter()
        .map(|(key_id, public_key)| {
            json!({"key_id": key_id, "algorithm": "ed25519", "public_key_b64": public_key})
        })
        .collect();
    (StatusCode::OK, Json(json!({"keys": keys}))).into_response()
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let receipt = match load_owned(&st, &headers, &id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match st.receipt_verifier.verify(&receipt) {
        Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"valid": false, "error": msg})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_broker::InvokeInput;
    use opensesame_domain::*;
    use serde_json::json;

    async fn state_with_receipt() -> (AppState, InvocationReceipt, String, OrganizationId) {
        let state = crate::app_state::test_demo_state().await;
        let boot = state.bootstrap.lock().unwrap().clone().unwrap();
        let parameters = json!({});
        let now = Utc::now();
        let receipt = state
            .broker
            .invoke(InvokeInput {
                intent: Intent {
                    id: IntentId::new(),
                    organization_id: boot.org,
                    project_id: Some(boot.project),
                    principal_id: boot.principal,
                    actor_id: boot.actor,
                    actor_instance_id: None,
                    client_id: None,
                    operator_id: None,
                    connection_id: Some(boot.connection),
                    operation: "repository.read".into(),
                    resource: "repo:acme/catalog".into(),
                    audience: "https://api.github.com".into(),
                    normalized_parameters_hash: Intent::parameters_hash(&parameters).unwrap(),
                    body_hash: None,
                    nonce: uuid::Uuid::new_v4().to_string(),
                    idempotency_key: uuid::Uuid::new_v4().to_string(),
                    issued_at: now,
                    expires_at: now + Duration::minutes(5),
                    parent_invocation_id: None,
                    delegation_chain: vec![boot.grant.id],
                    proof: DetachedProof {
                        algorithm: "EdDSA".into(),
                        key_thumbprint: "test".into(),
                        signature: "test".into(),
                    },
                },
                grant: boot.grant.clone(),
                subject: "user:demo".into(),
                connection_policy_id: "demo-conn".into(),
                parameters,
            })
            .await
            .unwrap();
        (
            state,
            receipt,
            format!("prn_{}", boot.principal.as_uuid()),
            boot.org,
        )
    }

    #[tokio::test]
    async fn same_principal_cannot_get_or_verify_another_organizations_receipt() {
        let (state, receipt, subject, _) = state_with_receipt().await;
        let headers =
            crate::app_state::test_session_headers(&state, &subject, OrganizationId::new());

        let get_response = get(
            State(state.clone()),
            headers.clone(),
            Path(receipt.id.to_string()),
        )
        .await;
        assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
        let verify_response = verify(State(state), headers, Path(receipt.id.to_string())).await;
        assert_eq!(verify_response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn matching_organization_and_operator_can_read_receipt_evidence() {
        let (state, receipt, subject, organization_id) = state_with_receipt().await;
        let session_headers =
            crate::app_state::test_session_headers(&state, &subject, organization_id);
        let get_response = get(
            State(state.clone()),
            session_headers,
            Path(receipt.id.to_string()),
        )
        .await;
        assert_eq!(get_response.status(), StatusCode::OK);

        let mut operator_headers = axum::http::HeaderMap::new();
        operator_headers.insert(
            "x-opensesame-operator",
            state.operator_token.parse().unwrap(),
        );
        let verify_response = verify(
            State(state),
            operator_headers,
            Path(receipt.id.to_string()),
        )
        .await;
        assert_eq!(verify_response.status(), StatusCode::OK);
    }
}
