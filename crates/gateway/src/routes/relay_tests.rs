use super::*;
use axum::extract::State;
use opensesame_connection_broker::delegation::{
    ClaimOfferRequest, MintOfferRequest, OfferItemSpec,
};
use opensesame_connection_broker::model::ConnectionStatus;
use opensesame_connection_broker::store as broker_store;
use opensesame_domain::{ConnectionId, EgressBinding, OrganizationId, OrganizationRole};

const OWNER: &str = "principal:00000000-0000-4000-8000-000000000015";
const GUEST: &str = "principal:00000000-0000-4000-8000-000000000016";

async fn relay_delegation(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    mode: ExecutionMode,
) -> String {
    let now = Utc::now();
    let row = broker_store::ConnectionRow {
        id: ConnectionId::new().to_string(),
        organization_id: org.to_string(),
        project_id: None,
        provider_id: "github".into(),
        integration_id: "deployment:github".into(),
        logical_name: format!("github-{}", uuid::Uuid::now_v7().simple()),
        display_name: "Holder's GitHub".into(),
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
        .expect("insert connection");
    claim_relay_delegation(state, org, &row.id, mode).await
}

async fn claim_relay_delegation(
    state: &AppState,
    org: OrganizationId,
    connection_id: &str,
    mode: ExecutionMode,
) -> String {
    let minted = state
        .connection_broker
        .mint_delegation_offer(
            &org,
            OWNER,
            MintOfferRequest {
                items: vec![OfferItemSpec {
                    connection_id: connection_id.to_owned(),
                    actions: Some(vec!["repository.read".into()]),
                    resources: None,
                    expires_in_seconds: None,
                    budgets: None,
                    execution_mode: mode,
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
    let delegations = state
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
    delegations[0].id.clone()
}

async fn body_json(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

fn submit_body(delegation_id: &str) -> SubmitRequest {
    SubmitRequest {
        delegation_id: delegation_id.into(),
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        parameters: Some(json!({})),
    }
}

async fn open_relay_request(
    state: &AppState,
    holder: &axum::http::HeaderMap,
    delegate: &axum::http::HeaderMap,
    delegation_id: &str,
) -> (String, String) {
    // An offline holder is the end of the request, not a queue.
    let refused = submit(
        State(state.clone()),
        delegate.clone(),
        Json(submit_body(delegation_id)),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(refused).await["error"], json!("holder_offline"));

    // The holder announces itself; now the request parks in its inbox.
    heartbeat(State(state.clone()), holder.clone()).await;
    let accepted = submit(
        State(state.clone()),
        delegate.clone(),
        Json(submit_body(delegation_id)),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    let accepted = body_json(accepted).await;
    let id = accepted["id"].as_str().expect("id").to_string();
    let digest = accepted["request_digest"]
        .as_str()
        .expect("digest")
        .to_string();

    let inbox = body_json(pending(State(state.clone()), holder.clone()).await).await;
    assert_eq!(inbox["requests"][0]["id"], json!(id.clone()));

    // Reporting a result before approval is refused: approval is the gate.
    let early = result(
        State(state.clone()),
        holder.clone(),
        Path(id.clone()),
        Json(ResultRequest {
            executed_digest: digest.clone(),
            outcome: "succeeded".into(),
            safe_summary: None,
        }),
    )
    .await;
    assert_eq!(early.status(), StatusCode::FORBIDDEN);
    (id, digest)
}

async fn approve_and_complete_relay(
    state: &AppState,
    holder: &axum::http::HeaderMap,
    id: &str,
    digest: &str,
) {
    // Approval binds to bytes: a wrong digest echo approves nothing.
    let wrong = approve(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(DecideRequest {
            request_digest: "sha256:0000".into(),
        }),
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
    let approved = approve(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(DecideRequest {
            request_digest: digest.to_string(),
        }),
    )
    .await;
    assert_eq!(approved.status(), StatusCode::OK);

    // Executing something other than what was approved is refused.
    let drifted = result(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(ResultRequest {
            executed_digest: "sha256:1111".into(),
            outcome: "succeeded".into(),
            safe_summary: None,
        }),
    )
    .await;
    assert_eq!(drifted.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(drifted).await["error"], json!("digest_mismatch"));

    // A summary that smells like credential material never lands.
    let leaking = result(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(ResultRequest {
            executed_digest: digest.to_string(),
            outcome: "succeeded".into(),
            safe_summary: Some(json!({"note": "token ghp_PLANTED"})),
        }),
    )
    .await;
    assert_eq!(leaking.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let done = result(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(ResultRequest {
            executed_digest: digest.to_string(),
            outcome: "succeeded".into(),
            safe_summary: Some(json!({"resource": "repo:acme/catalog"})),
        }),
    )
    .await;
    assert_eq!(done.status(), StatusCode::OK);
}

#[tokio::test]
async fn contract_the_full_relay_round_trip_is_digest_bound() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);

    let (id, digest) = open_relay_request(&state, &holder, &delegate, &delegation_id).await;
    approve_and_complete_relay(&state, &holder, &id, &digest).await;

    // The delegate reads the outcome; a stranger reads nothing.
    let seen = get(State(state.clone()), delegate.clone(), Path(id.clone())).await;
    assert_eq!(seen.status(), StatusCode::OK);
    assert_eq!(body_json(seen).await["outcome"], json!("succeeded"));
    let stranger = crate::app_state::test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000014",
        org,
        OrganizationRole::Member,
    );
    let hidden = get(State(state.clone()), stranger, Path(id)).await;
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn adversarial_a_broker_delegation_does_not_open_the_relay() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation_id = relay_delegation(&state, org, ExecutionMode::Broker).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    heartbeat(State(state.clone()), holder).await;
    let refused = submit(
        State(state.clone()),
        delegate,
        Json(submit_body(&delegation_id)),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(refused).await["error"], json!("not_relay_mode"));
}

#[tokio::test]
async fn adversarial_a_relayed_ask_outside_the_grant_never_reaches_the_inbox() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    heartbeat(State(state.clone()), holder.clone()).await;
    // An inbox is not a place to launder wider asks: the fence runs at
    // submit, before a human ever sees a prompt to mis-approve.
    let mut wider = submit_body(&delegation_id);
    wider.operation = "contents.write".into();
    let refused = submit(State(state.clone()), delegate, Json(wider)).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let inbox = body_json(pending(State(state.clone()), holder).await).await;
    assert_eq!(inbox["requests"], json!([]));
}

#[tokio::test]
async fn queued_requests_recheck_revocation_expiry_and_narrowing_before_execution() {
    for change in ["revoke", "expire", "narrow"] {
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
        let holder =
            crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
        let delegate =
            crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
        let (id, digest) = open_relay_request(&state, &holder, &delegate, &delegation_id).await;
        // First prove ordinary approval works. Then change authority while the
        // approved request is queued, before the holder retrieves it to execute.
        assert_eq!(
            approve(
                State(state.clone()),
                holder.clone(),
                Path(id.clone()),
                Json(DecideRequest {
                    request_digest: digest.clone()
                })
            )
            .await
            .status(),
            StatusCode::OK
        );
        match change {
            "revoke" => state
                .connection_broker
                .revoke_delegation(&org, OWNER, &delegation_id)
                .await
                .unwrap(),
            "expire" => {
                sqlx::query("UPDATE connection_delegations SET expires_at = ? WHERE id = ?")
                    .bind((Utc::now() - Duration::seconds(1)).to_rfc3339())
                    .bind(&delegation_id)
                    .execute(state.connection_broker.pool())
                    .await
                    .unwrap();
            }
            _ => {
                state
                    .connection_broker
                    .narrow_delegation(&org, OWNER, &delegation_id, Some(vec![]), None, None)
                    .await
                    .unwrap();
            }
        }
        let inbox = body_json(pending(State(state.clone()), holder.clone()).await).await;
        assert_eq!(inbox["requests"], json!([]), "{change}");
        let refused = result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: digest,
                outcome: "succeeded".into(),
                safe_summary: None,
            }),
        )
        .await;
        assert!(!refused.status().is_success(), "{change}");
    }
}

#[path = "relay_authority_tests.rs"]
mod authority;
