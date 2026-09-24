//! PAM calls traverse the complete router with real sender-constrained proofs.
use super::*;

#[tokio::test]
async fn pam_session_requires_identity_and_cannot_cross_principal_or_organization() {
    let state = crate::app_state::test_demo_state().await;
    let _lock = crate::app_state::test_env::lock();
    let _restore = OriginEnvironment(std::env::var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS").ok());
    std::env::set_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS", ORIGIN);
    let fixture = paired_fixture(&state).await;
    config_access::provision_native_role(
        state.db.pool(),
        &fixture.org,
        &fixture.principal,
        OrganizationRole::Member,
    )
    .await
    .unwrap();
    let app = crate::routes::router(state.clone());
    let body = json!({
        "principal_id": fixture.principal.to_string(),
        "organization_id": fixture.org.to_string(),
        "capabilities": [{"action": "read", "resource": "fixture/resource"}],
        "ttl_seconds": 900
    });
    assert_eq!(
        fixture
            .client
            .request(&app, "POST", "/api/v1/tasks", body.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    authenticate_fixture(&state, &fixture.client_id, fixture.now).await;
    let mut wrong = body.clone();
    wrong["principal_id"] = json!(PrincipalId::new().to_string());
    assert_eq!(
        fixture
            .client
            .request(&app, "POST", "/api/v1/tasks", wrong)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong = body.clone();
    wrong["organization_id"] = json!(OrganizationId::new().to_string());
    assert_eq!(
        fixture
            .client
            .request(&app, "POST", "/api/v1/tasks", wrong)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, created) = fixture
        .client
        .request(&app, "POST", "/api/v1/tasks", body)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let path = format!("/api/v1/tasks/{}", created["task_run_id"].as_str().unwrap());
    assert_eq!(fixture.client.get(&app, &path).await.0, StatusCode::OK);
    assert_eq!(
        fixture.client.get(&app, "/api/v1/tasks").await.0,
        StatusCode::OK
    );
    let result = fixture
        .client
        .request(
            &app,
            "POST",
            &format!("{path}/terminate"),
            json!({"expected_state_version": created["state_version"]}),
        )
        .await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    assert_eq!(
        fixture.client.get(&app, &path).await.1["status"],
        "cancelled"
    );
    assert!(state
        .db
        .revoke_browser_client(
            &fixture.client_id,
            &fixture.principal.to_string(),
            &fixture.org.to_string(),
            fixture.now
        )
        .await
        .unwrap());
    assert_eq!(
        fixture.client.get(&app, &path).await.0,
        StatusCode::UNAUTHORIZED
    );
}
