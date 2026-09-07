use super::*;

#[tokio::test]
async fn materialize_refuses_a_provider_with_no_mint_path_without_dialling_it() {
    let (router, state) = facade().await;
    let organization_id = operator_org(&state).await;
    let operator = state.operator_token.clone();
    seed_connection(
        &state,
        &organization_id,
        "aws-prod",
        "aws",
        None,
        "derived_short_lived",
    )
    .await;

    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/materialize/aws-prod",
        Some(&operator),
    )
    .await;
    // 422 is the broker's own answer for "this provider cannot mint"; the
    // refusal happens before any HTTP client is built, so the test is offline.
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(receipt.is_none());
    assert!(!body.to_string().contains("derived_token"));
}

#[tokio::test]
async fn members_cannot_materialize_organization_app_tokens() {
    let (router, state) = facade().await;
    let organization_id = boot_org(&state);
    let headers = app_state::test_session_headers(
        &state,
        "user:member",
        organization_id,
        OrganizationRole::Member,
    );
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .unwrap()
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    seed_connection(
        &state,
        &organization_id,
        "member-app",
        "github",
        Some("user:member"),
        "derived_short_lived",
    )
    .await;
    let (status, body, receipt) = call(
        &router,
        "GET",
        "/v1/secret/data/materialize/member-app?installation_id=777",
        Some(token),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errors"][0], "owner or admin role required");
    assert!(receipt.is_none());
}
