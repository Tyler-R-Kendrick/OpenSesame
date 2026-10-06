use super::*;

async fn issue_alias(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    target: &str,
) -> opensesame_storage::credential_canaries::IssuedControlledAlias {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/app-core/src/lib/credential-canaries/protocol-vectors.json"
    ))
    .unwrap();
    let vector = &vectors["vectors"][0];
    let artifact = serde_json::from_value(json!({ "id": "00000000-0000-4000-8000-000000000071", "context": vector["context"], "digestB64": vector["digestB64"], "state": "bait", "createdAt": "2026-10-06T00:00:00Z" })).unwrap();
    state
        .broker
        .db
        .register_controlled_canary(
            &opensesame_storage::credential_canaries::HostCanaryBinding {
                organization_id: org,
                tomb: "personal".into(),
                vault_identity: "public-vector-vault".into(),
            },
            &artifact,
        )
        .await
        .unwrap();
    let expires =
        (Utc::now() + Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    state
        .broker
        .db
        .issue_controlled_alias(
            &org,
            "personal",
            &ConnectionId::parse(target).unwrap(),
            &expires,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn active_alias_obeys_original_delegation_and_retirement_stops_queued_dispatch() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let target = delegable_github_row(&state, org).await;
    delegate_to_guest(&state, org, &target).await;
    let alias = issue_alias(&state, org, &target).await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let active = create(
        State(state.clone()),
        headers.clone(),
        Json(invoke_body(&alias.reference, "repository.read")),
    )
    .await;
    assert_eq!(
        active.status(),
        StatusCode::OK,
        "active alias retains ordinary delegated execution"
    );
    super::super::intents_queue::hold_next_invoke();
    let queued = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&alias.reference, "repository.read")),
    )
    .await;
    assert_eq!(queued.status(), StatusCode::ACCEPTED);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
    state
        .broker
        .db
        .retire_controlled_alias(&org, &alias.issuer_record_ref)
        .await
        .unwrap();
    let drained = super::super::intents_queue::drain(&state).await;
    assert_eq!(drained.status(), StatusCode::FORBIDDEN);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
    let status = state
        .broker
        .db
        .controlled_canary_status(&org, "personal")
        .await
        .unwrap();
    assert!(status.events.iter().any(|event| event.phase
        == opensesame_human_vault::credential_canaries::Phase::RetiredGenerationObserved));
}

#[tokio::test]
async fn resolved_alias_is_rechecked_after_retirement_before_any_executor() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let target = delegable_github_row(&state, boot.org).await;
    delegate_to_guest(&state, boot.org, &target).await;
    let alias = issue_alias(&state, boot.org, &target).await;
    let resolved = resolve_invocation(
        &state,
        &boot,
        GUEST,
        &invoke_body(&alias.reference, "repository.read"),
        1,
    )
    .await
    .unwrap_or_else(|_| panic!("active alias should resolve through original delegation"));
    state
        .broker
        .db
        .retire_controlled_alias(&boot.org, &alias.issuer_record_ref)
        .await
        .unwrap();
    assert!(super::super::assert_alias_current(&state, &resolved)
        .await
        .is_err());
    let forged = invoke_body("osissued:v1:forged", "repository.read");
    assert!(resolve_invocation(&state, &boot, GUEST, &forged, 1)
        .await
        .is_err());
}
