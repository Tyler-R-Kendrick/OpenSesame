//! Frozen request identity and late authority changes.

use super::*;

#[tokio::test]
async fn revoked_request_cannot_be_approved_after_the_holder_read_it() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation_id = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, digest) = open_relay_request(&state, &holder, &delegate, &delegation_id).await;
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation_id)
        .await
        .unwrap();
    assert_eq!(
        approve(
            State(state),
            holder,
            Path(id),
            Json(DecideRequest {
                request_digest: digest
            })
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn newer_claim_does_not_replace_a_frozen_relay_delegation() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let first = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, digest) = open_relay_request(&state, &holder, &delegate, &first).await;
    let resolved = state
        .connection_broker
        .find_live_delegation_by_id(GUEST, &first)
        .await
        .unwrap()
        .unwrap();
    let newer =
        claim_relay_delegation(&state, org, &resolved.connection_id, ExecutionMode::Broker).await;
    // Explicit ordering removes clock precision from the regression.
    sqlx::query("UPDATE connection_delegations SET created_at = ? WHERE id = ?")
        .bind((Utc::now() + Duration::seconds(1)).to_rfc3339())
        .bind(&newer)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let inbox = body_json(pending(State(state.clone()), holder.clone()).await).await;
    assert_eq!(inbox["requests"][0]["id"], json!(id));
    approve_and_complete_relay(&state, &holder, &id, &digest).await;
    // Exact identity remains live, but never bypasses ancestor revocation.
    sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(resolved.parent_grant_id.to_string())
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    assert!(state
        .connection_broker
        .find_live_delegation_by_id(GUEST, &first)
        .await
        .unwrap()
        .is_none());
    let mut expired_parent = resolved.parent_grant;
    expired_parent.constraints.expires_at = Utc::now() - Duration::seconds(1);
    sqlx::query("UPDATE grants SET revoked_at = NULL, body_json = ? WHERE id = ?")
        .bind(serde_json::to_string(&expired_parent).unwrap())
        .bind(resolved.parent_grant_id.to_string())
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    assert!(state
        .connection_broker
        .find_live_delegation_by_id(GUEST, &first)
        .await
        .unwrap()
        .is_none());
}
