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
    let minted = state
        .connection_broker
        .mint_delegation_offer(
            &org,
            OWNER,
            MintOfferRequest {
                items: vec![OfferItemSpec {
                    connection_id: row.id.clone(),
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
            execution_lease: None,
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
    let approved = body_json(approved).await;
    let lease = approved["execution_lease"]
        .as_str()
        .expect("lease")
        .to_string();

    // Executing something other than what was approved is refused.
    let drifted = result(
        State(state.clone()),
        holder.clone(),
        Path(id.to_string()),
        Json(ResultRequest {
            execution_lease: Some(lease.clone()),
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
            execution_lease: Some(lease.clone()),
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
            execution_lease: Some(lease.clone()),
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

struct Fixture {
    state: AppState,
    org: OrganizationId,
    delegation: String,
    holder: axum::http::HeaderMap,
    id: String,
    digest: String,
}

async fn fixture() -> Fixture {
    let state = crate::app_state::test_demo_state().await;
    fixture_with_state(state).await
}

async fn fixture_with_state(state: AppState) -> Fixture {
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, digest) = open_relay_request(&state, &holder, &delegate, &delegation).await;
    Fixture {
        state,
        org,
        delegation,
        holder,
        id,
        digest,
    }
}

async fn acquire(f: &Fixture) -> Response {
    approve(
        State(f.state.clone()),
        f.holder.clone(),
        Path(f.id.clone()),
        Json(DecideRequest {
            request_digest: f.digest.clone(),
        }),
    )
    .await
}

async fn inbox(f: &Fixture) -> Value {
    body_json(pending(State(f.state.clone()), f.holder.clone()).await).await
}

async fn mutate_grant(
    f: &Fixture,
    parent: bool,
    mutate: impl FnOnce(&mut opensesame_domain::Grant),
) {
    let column = if parent {
        "parent_grant_id"
    } else {
        "grant_id"
    };
    let id: String = sqlx::query_scalar(&format!(
        "SELECT {column} FROM connection_delegations WHERE id = ?"
    ))
    .bind(&f.delegation)
    .fetch_one(f.state.connection_broker.pool())
    .await
    .unwrap();
    let raw: String = sqlx::query_scalar("SELECT body_json FROM grants WHERE id = ?")
        .bind(&id)
        .fetch_one(f.state.connection_broker.pool())
        .await
        .unwrap();
    let mut grant: opensesame_domain::Grant = serde_json::from_str(&raw).unwrap();
    mutate(&mut grant);
    sqlx::query("UPDATE grants SET body_json = ? WHERE id = ?")
        .bind(serde_json::to_string(&grant).unwrap())
        .bind(id)
        .execute(f.state.connection_broker.pool())
        .await
        .unwrap();
}

async fn assert_unavailable(f: &Fixture) {
    // Cached prompt approval must fail even before the next inbox drain.
    assert_eq!(acquire(f).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(inbox(f).await["requests"], json!([]));
    let state: String = sqlx::query_scalar("SELECT state FROM relay_requests WHERE id = ?")
        .bind(&f.id)
        .fetch_one(f.state.connection_broker.pool())
        .await
        .unwrap();
    assert_ne!(state, "approved");
}

#[tokio::test]
async fn revoked_delegation_invalidates_cached_prompt_and_inbox() {
    let f = fixture().await;
    f.state
        .connection_broker
        .revoke_delegation(&f.org, OWNER, &f.delegation)
        .await
        .unwrap();
    assert_unavailable(&f).await;
}

#[tokio::test]
async fn live_authority_rechecks_delegation_and_grant_time_windows() {
    for variant in 0..4 {
        let f = fixture().await;
        match variant {
            0 => {
                sqlx::query("UPDATE connection_delegations SET expires_at = ? WHERE id = ?")
                    .bind((Utc::now() - Duration::seconds(1)).to_rfc3339())
                    .bind(&f.delegation)
                    .execute(f.state.connection_broker.pool())
                    .await
                    .unwrap();
            }
            1 => {
                mutate_grant(&f, false, |g| {
                    g.constraints.expires_at = Utc::now() - Duration::seconds(1)
                })
                .await
            }
            2 => {
                mutate_grant(&f, false, |g| {
                    g.constraints.not_before = Some(Utc::now() + Duration::seconds(60))
                })
                .await
            }
            _ => {
                mutate_grant(&f, true, |g| {
                    g.constraints.expires_at = Utc::now() - Duration::seconds(1)
                })
                .await
            }
        }
        assert_unavailable(&f).await;
    }
}

#[tokio::test]
async fn revoked_parent_is_checked_before_acquisition() {
    let f = fixture().await;
    sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = (SELECT parent_grant_id FROM connection_delegations WHERE id = ?)")
        .bind(Utc::now().to_rfc3339()).bind(&f.delegation)
        .execute(f.state.connection_broker.pool()).await.unwrap();
    assert_unavailable(&f).await;
}

#[tokio::test]
async fn authority_identity_and_execution_mode_cannot_drift() {
    for (column, value) in [
        ("owner_subject", GUEST),
        ("claimant_subject", OWNER),
        ("organization_id", "00000000-0000-4000-8000-000000000099"),
        ("execution_mode", "broker"),
    ] {
        let f = fixture().await;
        sqlx::query(&format!(
            "UPDATE connection_delegations SET {column} = ? WHERE id = ?"
        ))
        .bind(value)
        .bind(&f.delegation)
        .execute(f.state.connection_broker.pool())
        .await
        .unwrap();
        assert_unavailable(&f).await;
    }
    let f = fixture().await;
    sqlx::query("UPDATE relay_requests SET connection_id = 'unrelated' WHERE id = ?")
        .bind(&f.id)
        .execute(f.state.connection_broker.pool())
        .await
        .unwrap();
    assert_unavailable(&f).await;
}

#[tokio::test]
async fn narrowing_rechecks_operation_and_resource_but_preserves_covered_requests() {
    for variant in 0..3 {
        let f = fixture().await;
        let (actions, resources) = match variant {
            0 => (Some(Vec::<String>::new()), None),
            1 => (None, Some(vec!["repo:acme/other".into()])),
            _ => (None, Some(vec!["repo:acme/catalog".into()])),
        };
        f.state
            .connection_broker
            .narrow_delegation(&f.org, OWNER, &f.delegation, actions, resources, None)
            .await
            .unwrap();
        if variant == 2 {
            assert_eq!(inbox(&f).await["requests"][0]["id"], json!(f.id));
            assert_eq!(acquire(&f).await.status(), StatusCode::OK);
        } else {
            assert_unavailable(&f).await;
        }
    }
}

async fn report(f: &Fixture, lease: Option<String>) -> Response {
    result(
        State(f.state.clone()),
        f.holder.clone(),
        Path(f.id.clone()),
        Json(ResultRequest {
            execution_lease: lease,
            executed_digest: f.digest.clone(),
            outcome: "succeeded".into(),
            safe_summary: None,
        }),
    )
    .await
}

#[tokio::test]
async fn acquisition_is_single_use_and_results_require_its_lease() {
    let f = fixture().await;
    let response = acquire(&f).await;
    assert_eq!(response.status(), StatusCode::OK);
    let receipt = body_json(response).await;
    let lease = receipt["execution_lease"].as_str().unwrap().to_string();
    assert!(!lease.is_empty());
    assert!(receipt["authority_digest"]
        .as_str()
        .is_some_and(|v| !v.is_empty()));
    assert_eq!(acquire(&f).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(inbox(&f).await["requests"], json!([]));
    assert!(!report(&f, None).await.status().is_success());
    assert!(!report(&f, Some("wrong-lease".into()))
        .await
        .status()
        .is_success());
    assert_eq!(
        report(&f, Some(lease.clone())).await.status(),
        StatusCode::OK
    );
    assert!(!report(&f, Some(lease)).await.status().is_success());
}

#[tokio::test]
async fn acquired_in_flight_result_survives_start_deadline_and_revocation() {
    let f = fixture().await;
    let receipt = body_json(acquire(&f).await).await;
    let lease = receipt["execution_lease"].as_str().unwrap().to_string();
    sqlx::query("UPDATE relay_requests SET execution_expires_at = ? WHERE id = ?")
        .bind((Utc::now() - Duration::seconds(1)).to_rfc3339())
        .bind(&f.id)
        .execute(f.state.connection_broker.pool())
        .await
        .unwrap();
    f.state
        .connection_broker
        .revoke_delegation(&f.org, OWNER, &f.delegation)
        .await
        .unwrap();
    assert_eq!(report(&f, Some(lease)).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn denial_remains_available_after_revocation() {
    let f = fixture().await;
    f.state
        .connection_broker
        .revoke_delegation(&f.org, OWNER, &f.delegation)
        .await
        .unwrap();
    let denied = deny(
        State(f.state.clone()),
        f.holder.clone(),
        Path(f.id.clone()),
        Json(DecideRequest {
            request_digest: f.digest.clone(),
        }),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::OK);
    assert_eq!(body_json(denied).await["state"], json!("denied"));
}

#[tokio::test]
async fn malformed_or_changed_frozen_request_is_never_acquired() {
    for (column, value) in [
        ("parameters_json", "{"),
        ("parameters_json", "{\"changed\":true}"),
        ("request_digest", "sha256:changed"),
    ] {
        let f = fixture().await;
        sqlx::query(&format!(
            "UPDATE relay_requests SET {column} = ? WHERE id = ?"
        ))
        .bind(value)
        .bind(&f.id)
        .execute(f.state.connection_broker.pool())
        .await
        .unwrap();
        assert_unavailable(&f).await;
    }
}

#[tokio::test]
async fn request_expiry_blocks_acquisition_and_result_reporting() {
    for acquire_first in [false, true] {
        let f = fixture().await;
        let lease = if acquire_first {
            Some(
                body_json(acquire(&f).await).await["execution_lease"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            )
        } else {
            None
        };
        sqlx::query("UPDATE relay_requests SET expires_at = ? WHERE id = ?")
            .bind((Utc::now() - Duration::seconds(1)).to_rfc3339())
            .bind(&f.id)
            .execute(f.state.connection_broker.pool())
            .await
            .unwrap();
        if acquire_first {
            assert!(!report(&f, lease).await.status().is_success());
        } else {
            assert_unavailable(&f).await;
        }
    }
}

#[tokio::test]
async fn execution_deadline_is_bounded_by_authority_and_short_lease_window() {
    for bound in ["request", "delegation", "child", "parent"] {
        let f = fixture().await;
        let limit = Utc::now() + Duration::seconds(3);
        match bound {
            "request" => {
                sqlx::query("UPDATE relay_requests SET expires_at = ? WHERE id = ?")
                    .bind(limit.to_rfc3339())
                    .bind(&f.id)
                    .execute(f.state.connection_broker.pool())
                    .await
                    .unwrap();
            }
            "delegation" => {
                sqlx::query("UPDATE connection_delegations SET expires_at = ? WHERE id = ?")
                    .bind(limit.to_rfc3339())
                    .bind(&f.delegation)
                    .execute(f.state.connection_broker.pool())
                    .await
                    .unwrap();
            }
            "child" => mutate_grant(&f, false, |g| g.constraints.expires_at = limit).await,
            _ => mutate_grant(&f, true, |g| g.constraints.expires_at = limit).await,
        }
        let before = Utc::now();
        let response = acquire(&f).await;
        assert_eq!(response.status(), StatusCode::OK);
        let receipt = body_json(response).await;
        let deadline = DateTime::parse_from_rfc3339(receipt["execute_before"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        assert!(deadline > before);
        assert!(deadline <= limit);
        assert!(deadline <= Utc::now() + Duration::seconds(5));
    }
}

#[tokio::test]
async fn concurrent_approvals_issue_exactly_one_lease() {
    let f = fixture().await;
    let (left, right) = tokio::join!(acquire(&f), acquire(&f));
    let statuses = [left.status(), right.status()];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 1);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::NOT_FOUND)
            .count(),
        1
    );
}

#[tokio::test]
async fn invalid_first_page_is_retired_so_later_valid_work_is_visible() {
    let f = fixture().await;
    // Place invalid rows before the real request, filling the old LIMIT 20.
    for index in 0..20 {
        sqlx::query("INSERT INTO relay_requests (id, delegation_id, connection_id, organization_id, holder_subject, delegate_subject, operation, resource, parameters_json, request_digest, state, expires_at, created_at) SELECT ?, delegation_id, connection_id, organization_id, holder_subject, delegate_subject, operation, resource, '{', request_digest, 'pending_approval', expires_at, ? FROM relay_requests WHERE id = ?")
            .bind(format!("invalid-{index:02}"))
            .bind((Utc::now() - Duration::seconds(60)).to_rfc3339()).bind(&f.id)
            .execute(f.state.connection_broker.pool()).await.unwrap();
    }
    // A bounded drain may process one page at a time, but cannot leave poison rows queued.
    pending(State(f.state.clone()), f.holder.clone()).await;
    let still_pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM relay_requests WHERE id LIKE 'invalid-%' AND state = 'pending_approval'")
        .fetch_one(f.state.connection_broker.pool()).await.unwrap();
    assert_eq!(still_pending, 0);
    assert_eq!(inbox(&f).await["requests"][0]["id"], json!(f.id));
}

#[tokio::test]
async fn file_backed_writer_revocation_precedes_execution_acquisition() {
    let mut state = crate::app_state::test_demo_state().await;
    let path =
        std::env::temp_dir().join(format!("relay-authority-{}.sqlite", uuid::Uuid::new_v4()));
    sqlx::query("VACUUM INTO ?")
        .bind(path.to_string_lossy().as_ref())
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    state.connection_broker = std::sync::Arc::new(
        opensesame_connection_broker::ConnectionBroker::new(
            pool.clone(),
            opensesame_connection_broker::BrokerConfig::default(),
        )
        .unwrap(),
    );
    let f = fixture_with_state(state).await;
    let mut writer = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *writer)
        .await
        .unwrap();
    sqlx::query("UPDATE connection_delegations SET revoked_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(&f.delegation)
        .execute(&mut *writer)
        .await
        .unwrap();
    let state = f.state.clone();
    let holder = f.holder.clone();
    let id = f.id.clone();
    let digest = f.digest.clone();
    let approval = tokio::spawn(async move {
        approve(
            State(state),
            holder,
            Path(id),
            Json(DecideRequest {
                request_digest: digest,
            }),
        )
        .await
    });
    tokio::task::yield_now().await;
    sqlx::query("COMMIT").execute(&mut *writer).await.unwrap();
    assert_eq!(approval.await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(inbox(&f).await["requests"], json!([]));
    drop(writer);
    drop(f);
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
