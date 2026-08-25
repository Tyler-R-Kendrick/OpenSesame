use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_broker::InvokeInput;
use opensesame_domain::{
    AuthorityOperation, ConnectionAuthorityBinding, ConnectionId, ConnectionRef, DetachedProof,
    Grant, GrantId, Intent, IntentId, InvokeLevel, OrganizationId, PrincipalId,
};
#[cfg(test)]
use opensesame_domain::{EgressBinding, OrganizationRole};
use opensesame_provider_openfga::TupleKey;
use serde::Deserialize;
use serde_json::{json, Value};

use opensesame_authz::{authorize_authority_use, AuthorityUse};
use opensesame_connection_broker::store as broker_store;

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, resolve_caller, resolve_caller_subject};

/// What a submitted ConnectionRef resolved to: whose grant will be exercised,
/// against which connection, through which connector component.
struct ResolvedInvocation {
    grant: Grant,
    delegation_chain: Vec<GrantId>,
    connection_id: ConnectionId,
    principal_id: PrincipalId,
    binding: ConnectionAuthorityBinding,
    connection_policy_id: String,
    /// Budget to decrement after authorization, when the path is delegated.
    spend_budget: Option<String>,
}

/// The connector component that executes operations for a provider. The WASM
/// host registers components by policy id, and today exactly one is mounted
/// (`demo-conn`); a provider whose operations that component does not carry
/// fails closed at invoke with a typed connector error rather than pretending
/// to execute. When per-provider components land, this becomes the lookup.
fn component_for_provider(_provider_id: &str) -> &'static str {
    "demo-conn"
}

#[derive(Deserialize)]
pub struct InvokeBody {
    /// Preferred agent API: `ConnectionRef` URI (conn://...).
    #[serde(default)]
    connection_ref: Option<String>,
    /// Legacy alias accepted as `ConnectionRef` logical name or URI.
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

async fn authorize_openfga(st: &AppState, subject: &str) -> Result<(), Response> {
    let Some(openfga) = &st.openfga else {
        return Ok(());
    };
    match openfga
        .check_tuple(&TupleKey {
            user: subject.into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        })
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error":"openfga_denied","type":"about:blank"})),
        )
            .into_response()),
        Err(error) => {
            // The transport error can embed the store URL and its bearer.
            tracing::warn!(%error, "openfga check failed");
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "openfga_unavailable", "type":"about:blank"})),
            )
                .into_response())
        }
    }
}

fn build_intent(
    body: InvokeBody,
    parameters: &Value,
    boot: &crate::app_state::Bootstrap,
    resolved: &ResolvedInvocation,
) -> Result<Intent, Response> {
    let param_hash = Intent::parameters_hash(parameters).map_err(|error| {
        let message = opensesame_redaction::redact_text(&error.to_string());
        (StatusCode::BAD_REQUEST, Json(json!({"error": message}))).into_response()
    })?;
    let now = Utc::now();
    Ok(Intent {
        id: IntentId::new(),
        organization_id: boot.org,
        project_id: Some(boot.project),
        principal_id: resolved.principal_id,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(resolved.connection_id),
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
        delegation_chain: resolved.delegation_chain.clone(),
        proof: DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "demo".into(),
            signature: "demo".into(),
        },
    })
}

pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(mut body): Json<InvokeBody>,
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
    let parameters = body.parameters.take().unwrap_or_else(|| json!({}));
    let default_ref = st
        .connection_ref
        .as_ref()
        .map(|c| c.handle.uri())
        .unwrap_or_default();
    let requested_ref = body
        .connection_ref
        .clone()
        .or_else(|| body.connection.clone())
        .unwrap_or(default_ref.clone());
    let level = body.invoke_level.unwrap_or(1);

    if level >= 3
        || body.operation.eq_ignore_ascii_case("credential.resolve")
        || body.operation.to_ascii_lowercase().contains("secret")
    {
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

    // Resolve the submitted reference. The bootstrap connection answers to
    // its own URI or logical name; anything else must be a connection the
    // caller holds a live delegation for. An unresolvable reference is 404 —
    // never a silent fallback to somebody else's connection, which is what
    // this route used to do by executing against the bootstrap regardless.
    let bootstrap_names = [
        default_ref.as_str(),
        st.connection_ref
            .as_ref()
            .map(|c| c.handle.logical_name.as_str())
            .unwrap_or(""),
        "",
    ];
    let resolved: ResolvedInvocation = if bootstrap_names.contains(&requested_ref.as_str()) {
        let connection_ref = match st.connection_ref.clone() {
            Some(connection_ref) => connection_ref,
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"bootstrap_unavailable"})),
                )
                    .into_response()
            }
        };
        ResolvedInvocation {
            grant: boot.grant.clone(),
            delegation_chain: vec![boot.grant.id],
            connection_id: boot.connection,
            principal_id: boot.principal,
            binding: opensesame_authz::github_binding(connection_ref, "github/main"),
            connection_policy_id: "demo-conn".into(),
            spend_budget: None,
        }
    } else {
        // A broker connection: by id, or by (org, logical name).
        let row = match broker_store::get_connection(st.connection_broker.pool(), &requested_ref)
            .await
        {
            Ok(Some(row)) if row.organization_id == boot.org.to_string() => Some(row),
            _ => match st.connection_broker.list_connections(&boot.org).await {
                Ok(views) => {
                    let matched = views
                        .iter()
                        .find(|view| view.logical_name == requested_ref)
                        .map(|view| view.connection_id.clone());
                    match matched {
                        Some(id) => broker_store::get_connection(st.connection_broker.pool(), &id)
                            .await
                            .ok()
                            .flatten(),
                        None => None,
                    }
                }
                Err(_) => None,
            },
        };
        let Some(row) = row else {
            return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
        };
        let Ok(Some(delegation)) = st
            .connection_broker
            .find_live_delegation(&subject, &row.id)
            .await
        else {
            // The caller holds no live delegation for it. Existence is not
            // confirmed either way.
            return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
        };
        // Delegates exercise at L1 in v1 (ADR 0044 decision 6).
        if level > 1 {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"invoke_level_not_delegated"})),
            )
                .into_response();
        }
        let connection_id = match ConnectionId::parse(&row.id) {
            Ok(id) => id,
            Err(_) => {
                return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
            }
        };
        let organization_id = OrganizationId::parse(&row.organization_id).unwrap_or(boot.org);
        let connection_ref = match ConnectionRef::new(
            organization_id,
            None,
            row.logical_name.clone(),
            connection_id,
        ) {
            Ok(connection_ref) => connection_ref,
            Err(_) => {
                return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
            }
        };
        let binding = ConnectionAuthorityBinding {
            connection_ref,
            internal_secret: None,
            credential_handle: None,
            egress: row.egress.clone(),
            max_invoke_level: InvokeLevel::TypedOperation,
        };
        let chain = vec![delegation.parent_grant_id, delegation.grant.id];
        let principal_id = delegation.grant.beneficiary_principal_id;
        let policy_id = component_for_provider(&row.provider_id).to_string();
        let grant = delegation.grant.clone();
        let delegation_id = delegation.delegation_id.clone();
        ResolvedInvocation {
            grant,
            delegation_chain: chain,
            connection_id,
            principal_id,
            binding,
            connection_policy_id: policy_id,
            spend_budget: Some(delegation_id),
        }
    };

    // The ADR 0005 fence, on the invoke path at last: reference is not
    // capability, level ceilings hold, egress fences L2, and the action must
    // be inside the grant that will be exercised.
    let invoke_level = match level {
        1 => InvokeLevel::TypedOperation,
        2 => InvokeLevel::ConstrainedHttp,
        _ => InvokeLevel::Materialize,
    };
    let requested_url = parameters.get("url").and_then(|v| v.as_str());
    let authority_use = AuthorityUse {
        subject: &subject,
        grant: &resolved.grant,
        binding: &resolved.binding,
        op: AuthorityOperation::Invoke,
        level: invoke_level,
        requested_url,
        requested_action: Some(&body.operation),
        connection_policy_id: &resolved.connection_policy_id,
    };
    match authorize_authority_use(&st.broker.policy, &authority_use) {
        Ok(decision) if decision.allowed => {}
        Ok(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"authority_denied","type":"about:blank"})),
            )
                .into_response()
        }
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": msg, "type":"about:blank"})),
            )
                .into_response();
        }
    }

    // Budgets decrement after authorization and before execution, and deny
    // when the decrement cannot be performed (ADR 0044 decision 10).
    if let Some(delegation_id) = &resolved.spend_budget {
        if st
            .connection_broker
            .spend_delegation_budget(
                delegation_id,
                opensesame_connection_broker::delegation::BUDGET_INVOCATIONS,
            )
            .await
            .is_err()
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"budget_exhausted"})),
            )
                .into_response();
        }
    }

    // Optional live OpenFGA check when configured — subject from session/operator, not a hard-coded demo user.
    if let Err(response) = authorize_openfga(&st, &subject).await {
        return response;
    }
    let intent = match build_intent(body, &parameters, &boot, &resolved) {
        Ok(intent) => intent,
        Err(response) => return response,
    };

    match st
        .broker
        .invoke(InvokeInput {
            intent,
            grant: resolved.grant.clone(),
            subject,
            connection_policy_id: resolved.connection_policy_id.clone(),
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
    use opensesame_domain::{OrganizationId, OrganizationRole};

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

    #[tokio::test]
    async fn bootstrap_intent_is_hidden_from_another_organization() {
        let state = crate::app_state::test_demo_state().await;
        let headers = crate::app_state::test_session_headers(
            &state,
            "user:demo",
            OrganizationId::new(),
            OrganizationRole::Member,
        );

        let response = create(State(state), headers, Json(body())).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn bootstrap_intent_remains_available_to_its_organization() {
        let state = crate::app_state::test_demo_state().await;
        let organization_id = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let headers = crate::app_state::test_session_headers(
            &state,
            "user:demo",
            organization_id,
            OrganizationRole::Member,
        );
        let mut request = body();
        request.operation = "repository.read".into();
        request.resource = "repo:acme/catalog".into();
        request.audience = Some("https://api.github.com".into());
        request.parameters = Some(json!({}));

        let response = create(State(state), headers, Json(request)).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[cfg(test)]
mod delegated_invoke_tests {
    use super::*;
    use axum::extract::State;
    use opensesame_connection_broker::delegation::{
        ClaimOfferRequest, MintOfferRequest, OfferItemSpec,
    };
    use opensesame_connection_broker::model::ConnectionStatus;
    use opensesame_connection_broker::store as broker_store;

    const OWNER: &str = "user:owner";
    const GUEST: &str = "user:guest";

    async fn delegable_github_row(
        state: &crate::app_state::AppState,
        org: OrganizationId,
    ) -> String {
        let now = Utc::now();
        let row = broker_store::ConnectionRow {
            id: ConnectionId::new().to_string(),
            organization_id: org.to_string(),
            project_id: None,
            provider_id: "github".into(),
            integration_id: "deployment:github".into(),
            logical_name: "github-owner".into(),
            display_name: "Owner's GitHub".into(),
            status: ConnectionStatus::Active,
            status_detail: None,
            requested_scopes: vec![],
            granted_scopes: vec![],
            account_label: None,
            owner_kind: "user".into(),
            owner_subject: Some(OWNER.into()),
            shareability: "delegable".into(),
            max_invoke_level: 2,
            materialization: "deny".into(),
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec!["api.github.com".into()],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
            created_at: now,
            updated_at: now,
        };
        broker_store::insert_connection(state.connection_broker.pool(), &row)
            .await
            .expect("insert broker connection");
        row.id
    }

    async fn delegate_to_guest(
        state: &crate::app_state::AppState,
        org: OrganizationId,
        connection_id: &str,
    ) -> Vec<opensesame_connection_broker::delegation::DelegationView> {
        let minted = state
            .connection_broker
            .mint_delegation_offer(
                &org,
                OWNER,
                MintOfferRequest {
                    items: vec![OfferItemSpec {
                        connection_id: connection_id.into(),
                        actions: Some(vec!["repository.read".into()]),
                        resources: None,
                        expires_in_seconds: None,
                        budgets: None,
                        execution_mode: opensesame_relay::ExecutionMode::Broker,
                        required: true,
                        dependencies: vec![],
                    }],
                    ttl_seconds: None,
                },
                &state.claim_pepper,
            )
            .await
            .expect("mint");
        let manifest = state
            .connection_broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        state
            .connection_broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                &state.claim_pepper,
            )
            .await
            .expect("claim")
    }

    fn invoke_body(connection_ref: &str, operation: &str) -> InvokeBody {
        InvokeBody {
            connection_ref: Some(connection_ref.into()),
            connection: None,
            operation: operation.into(),
            resource: "repo:acme/catalog".into(),
            audience: Some("https://api.github.com".into()),
            parameters: Some(json!({})),
            idempotency_key: None,
            invoke_level: None,
            task_run_id: None,
            intent_digest: None,
        }
    }

    #[tokio::test]
    async fn contract_a_delegate_exercises_through_its_child_grant() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection_id = delegable_github_row(&state, org).await;
        delegate_to_guest(&state, org, &connection_id).await;

        let headers =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        let response = create(
            State(state.clone()),
            headers,
            Json(invoke_body(&connection_id, "repository.read")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        let receipt: Value = serde_json::from_slice(&bytes).expect("receipt json");
        // The receipt names the lineage: parent (owner ceiling) then child.
        assert_eq!(
            receipt["delegation_chain"]
                .as_array()
                .map(|chain| chain.len()),
            Some(2)
        );
        assert_eq!(receipt["credential_bytes_returned"], json!(false));
        assert_eq!(receipt["outcome"], json!("succeeded"));
    }

    #[tokio::test]
    async fn adversarial_the_same_ref_is_nothing_to_anyone_else() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection_id = delegable_github_row(&state, org).await;
        delegate_to_guest(&state, org, &connection_id).await;

        let headers = crate::app_state::test_session_headers(
            &state,
            "user:stranger",
            org,
            OrganizationRole::Member,
        );
        let response = create(
            State(state.clone()),
            headers,
            Json(invoke_body(&connection_id, "repository.read")),
        )
        .await;
        // Knowing the connection id is not authorization, and the refusal
        // must not confirm the connection exists.
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn adversarial_an_action_outside_the_child_grant_is_refused() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection_id = delegable_github_row(&state, org).await;
        delegate_to_guest(&state, org, &connection_id).await;

        // The owner's ceiling allows pull_request.create; the child grant
        // deliberately does not. The delegate must be held to the child.
        let headers =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        let response = create(
            State(state.clone()),
            headers,
            Json(invoke_body(&connection_id, "pull_request.create")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn contract_revocation_ends_delegated_exercise() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection_id = delegable_github_row(&state, org).await;
        let delegations = delegate_to_guest(&state, org, &connection_id).await;
        state
            .connection_broker
            .revoke_delegation(&org, OWNER, &delegations[0].id)
            .await
            .expect("revoke");

        let headers =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        let response = create(
            State(state.clone()),
            headers,
            Json(invoke_body(&connection_id, "repository.read")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn property_budgets_deny_when_spent() {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection_id = delegable_github_row(&state, org).await;
        let minted = state
            .connection_broker
            .mint_delegation_offer(
                &org,
                OWNER,
                MintOfferRequest {
                    items: vec![OfferItemSpec {
                        connection_id: connection_id.clone(),
                        actions: Some(vec!["repository.read".into()]),
                        resources: None,
                        expires_in_seconds: None,
                        budgets: Some(
                            [(
                                opensesame_connection_broker::delegation::BUDGET_INVOCATIONS
                                    .to_string(),
                                1,
                            )]
                            .into_iter()
                            .collect(),
                        ),
                        execution_mode: opensesame_relay::ExecutionMode::Broker,
                        required: true,
                        dependencies: vec![],
                    }],
                    ttl_seconds: None,
                },
                &state.claim_pepper,
            )
            .await
            .expect("mint");
        let manifest = state
            .connection_broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        state
            .connection_broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                &state.claim_pepper,
            )
            .await
            .expect("claim");

        let headers =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        let first = create(
            State(state.clone()),
            headers.clone(),
            Json(invoke_body(&connection_id, "repository.read")),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        let second = create(
            State(state.clone()),
            headers,
            Json(invoke_body(&connection_id, "repository.read")),
        )
        .await;
        assert_eq!(second.status(), StatusCode::FORBIDDEN);
    }
}
