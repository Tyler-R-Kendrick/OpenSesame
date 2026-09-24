use super::*;

async fn assert_member_cannot_mint(state: &AppState, id: &str) {
    let member = session(state, "principal:00000000-0000-4000-8000-000000000001");
    let (status, denied) = as_session(
        state,
        &member,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({"installation_id": "777"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert!(!denied.to_string().contains(DERIVED_TOKEN));
}

#[tokio::test]
async fn github_mint_returns_a_derived_token_never_the_sealed_material() {
    let Some(pem) = mint_test_rsa_pem() else {
        eprintln!("skipping: openssl unavailable");
        return;
    };
    let api_base = github_api_server().await;
    let state = github_harness(&api_base).await;
    let alice = session_for(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Admin,
    );

    // An integration carrying GitHub App signing material, as the manifest
    // registration flow would have sealed it.
    let (status, integration) = call(
        &state,
        "POST",
        "/api/v1/integrations",
        Some(json!({
            "key": "github-app",
            "provider_id": "github",
            "display_name": "GitHub App",
            "client_id": "Iv1.test",
            "client_secret": GITHUB_APP_CLIENT_SECRET,
            "configuration": {"app_id": "4242", "private_key_pem": pem}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{integration}");
    let integration_id = integration["id"].as_str().unwrap();

    let (status, created) = as_session(
        &state,
        &alice,
        "POST",
        "/api/v1/connections",
        Some(json!({"integration_id": integration_id})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["connection_id"].as_str().unwrap();

    // Deny by default, even with everything else in place.
    let (status, body) = as_session(
        &state,
        &alice,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({"installation_id": "777"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "materialization_denied");

    opt_in(&state, &alice, id).await;

    assert_member_cannot_mint(&state, id).await;

    let (status, minted) = as_session(
        &state,
        &alice,
        "POST",
        &format!("/api/v1/connections/{id}/mint"),
        Some(json!({"installation_id": "777"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    assert_eq!(minted["derived_token"], DERIVED_TOKEN);
    assert_eq!(minted["kind"], "github_app_installation");
    assert_eq!(minted["provider_id"], "github");
    assert!(minted["expires_at"].is_string());
    // RFC 8693 mapping: subject = owning principal, actor = requesting caller.
    assert_eq!(
        minted["subject"],
        "principal:00000000-0000-4000-8000-000000000001"
    );
    assert_eq!(
        minted["actor"],
        "principal:00000000-0000-4000-8000-000000000001"
    );

    // The mint is on the connection's event trail.
    let (status, events) = as_session(
        &state,
        &alice,
        "GET",
        &format!("/api/v1/connections/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{events}");
    let rendered_events = events.to_string();
    assert!(rendered_events.contains("\"materialized\""), "{events}");
    assert!(
        rendered_events.contains("sub=principal:00000000-0000-4000-8000-000000000001"),
        "{events}"
    );
    assert!(
        rendered_events.contains("act=principal:00000000-0000-4000-8000-000000000001"),
        "{events}"
    );

    assert_mint_redaction(&pem, &minted, &rendered_events);
}

fn assert_mint_redaction(pem: &str, minted: &serde_json::Value, rendered_events: &str) {
    // Canary: nothing sealed (App private key, OAuth client secret) crosses in
    // the mint response or the event trail — only the provider-minted token.
    let pem_body = pem
        .lines()
        .find(|line| !line.starts_with("-----"))
        .unwrap_or_default();
    for banned in [pem_body, GITHUB_APP_CLIENT_SECRET, "private_key_pem"] {
        assert!(!banned.is_empty(), "empty canary");
        assert!(
            !minted.to_string().contains(banned),
            "mint response leaked {banned}"
        );
        assert!(
            !rendered_events.contains(banned),
            "event trail leaked {banned}"
        );
    }
}
