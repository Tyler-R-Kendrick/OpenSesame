//! GitHub App registration, rebinding and derived-token minting.

use super::*;

#[tokio::test]
async fn github_create_without_oauth_still_needs_a_sealing_key() {
    let (_db, broker) = broker_with(BrokerConfig::in_memory(None, "http://127.0.0.1:8787")).await;
    let err = broker
        .create_connection(&OrganizationId::new(), create("github"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "integration_not_found");
}

#[tokio::test]
async fn github_accepts_a_pasted_personal_access_token() {
    async fn github_user() -> Json<serde_json::Value> {
        Json(serde_json::json!({ "login": "ada" }))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind github mock");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new().route("/user", axum::routing::get(github_user)),
        )
        .await;
    });
    let base = format!("http://{address}");
    let (_db, broker) = broker_with(key_config().with_github_api_base(base)).await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();
    assert_eq!(view.status, ConnectionStatus::Pending);

    let active = broker
        .set_access_token(&org, &view.connection_id, "ghp_test_token_do_not_leak")
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert_eq!(active.account_label.as_deref(), Some("ada"));
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("ghp_test_token"));
}

#[tokio::test]
async fn register_github_app_credentials_seals_an_org_integration() {
    let (_db, broker) =
        broker_with(BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:18787")).await;
    let org = OrganizationId::new();
    let credentials = crate::github_app::GithubAppCredentials {
        id: 42,
        name: "OpenSesame test".into(),
        client_id: "Iv1.testclient".into(),
        client_secret: "ghs_test_secret_do_not_leak".into(),
        html_url: None,
        pem: None,
        webhook_secret: None,
    };
    let view = broker
        .register_github_app_credentials(&org, &credentials, "prn_tester")
        .await
        .unwrap();
    assert_eq!(view.provider_id, "github");
    assert!(view.configured);
    assert_eq!(view.source, IntegrationSource::Organization);
    assert_eq!(
        view.scopes,
        vec![
            "read:user".to_string(),
            "repo".to_string(),
            "read:org".to_string(),
            "workflow".to_string(),
        ]
    );
    assert!(!serde_json::to_string(&view)
        .unwrap()
        .contains("ghs_test_secret"));

    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: "github".into(),
                integration_id: Some(view.id.clone()),
                owner_subject: None,
                display_name: None,
                logical_name: None,
                project_id: None,
                scopes: Some(vec!["repo".into(), "read:user".into()]),
                shareability: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(connection.integration_id.as_deref(), Some(view.id.as_str()));
}

#[tokio::test]
async fn authorize_rebinds_deployment_github_after_org_app_register() {
    let (_db, broker) =
        broker_with(BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:18787")).await;
    let org = OrganizationId::new();

    // PAT / unconfigured path binds deployment:github with empty OAuth config.
    let pending = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: "github".into(),
                integration_id: None,
                owner_subject: None,
                display_name: Some("History".into()),
                logical_name: None,
                project_id: None,
                scopes: Some(vec!["repo".into(), "read:user".into()]),
                shareability: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(pending.integration_id.as_deref(), Some("deployment:github"));
    let before = broker
        .start_authorization(&org, &pending.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(before.code(), "provider_unconfigured");

    let credentials = crate::github_app::GithubAppCredentials {
        id: 99,
        name: "OpenSesame History".into(),
        client_id: "Iv1.oauth_client".into(),
        client_secret: "ghs_oauth_secret_do_not_leak".into(),
        html_url: None,
        pem: None,
        webhook_secret: None,
    };
    let integration = broker
        .register_github_app_credentials(&org, &credentials, "prn_tester")
        .await
        .unwrap();

    let start = broker
        .start_authorization(&org, &pending.connection_id, None, None)
        .await
        .unwrap();
    assert!(start.authorization_url.contains("github.com"));
    assert!(start.authorization_url.contains("Iv1.oauth_client"));
    // GitHub Apps must not send classic scope= — App permissions apply instead.
    assert!(
        !start.authorization_url.contains("scope="),
        "authorization_url unexpectedly included classic scopes: {}",
        start.authorization_url
    );

    let rebound = broker
        .get_connection(&org, &pending.connection_id)
        .await
        .unwrap();
    assert_eq!(
        rebound.integration_id.as_deref(),
        Some(integration.id.as_str())
    );
}

#[tokio::test]
async fn github_mint_returns_a_derived_token_and_records_the_delegation() {
    let Some(pem) = mint_test_rsa_pem() else {
        eprintln!("skipping: openssl unavailable");
        return;
    };
    let api_base = github_api_server().await;
    let (_db, broker, organization, integration_id) = github_app_broker(&api_base, &pem).await;
    let connection = broker
        .create_connection(
            &organization,
            CreateConnection {
                integration_id: Some(integration_id),
                owner_subject: Some("user:alice".into()),
                ..create("github")
            },
        )
        .await
        .unwrap();

    // The policy gate runs before any provider call.
    let denied = broker
        .mint_derived_token(
            &organization,
            &connection.connection_id,
            "user:alice",
            Some("777"),
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code(), "materialization_denied");

    // installation_id is required, and numeric.
    let opted_in = broker
        .update_policy(
            &organization,
            &connection.connection_id,
            Shareability::Private,
            2,
            Some(MaterializationPolicy::DerivedShortLived),
        )
        .await
        .unwrap();
    assert_eq!(
        opted_in.materialization,
        MaterializationPolicy::DerivedShortLived
    );
    for missing in [None, Some(""), Some("abc")] {
        let error = broker
            .mint_derived_token(
                &organization,
                &connection.connection_id,
                "user:alice",
                missing,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "invalid_request", "{missing:?}");
    }

    let minted = broker
        .mint_derived_token(
            &organization,
            &connection.connection_id,
            "user:alice",
            Some("777"),
        )
        .await
        .unwrap();
    assert_eq!(minted.derived_token, DERIVED_TOKEN);
    assert_eq!(minted.kind, "github_app_installation");
    assert_eq!(minted.provider_id, "github");
    // RFC 8693: the owner is the subject, the caller the actor.
    assert_eq!(minted.subject, "user:alice");
    assert_eq!(minted.actor, "user:alice");
    assert!(minted.expires_at > minted.issued_at);

    // The mint is in the connection's event trail, without token bytes.
    let events = broker
        .events(&organization, &connection.connection_id)
        .await
        .unwrap();
    let materialized = events
        .iter()
        .find(|event| event.kind == "materialized")
        .expect("materialized event");
    let detail = materialized.detail.as_deref().unwrap_or_default();
    assert!(detail.contains("sub=user:alice"), "{detail}");
    assert!(detail.contains("act=user:alice"), "{detail}");

    // Canary: the sealed material (App private key, OAuth client secret) never
    // appears in what the mint hands back or in the event trail.
    let pem_body = pem
        .lines()
        .find(|line| !line.starts_with("-----"))
        .unwrap_or_default()
        .to_string();
    let rendered =
        serde_json::to_string(&minted).unwrap() + &serde_json::to_string(&events).unwrap();
    for banned in [
        pem_body.as_str(),
        GITHUB_APP_CLIENT_SECRET,
        "private_key_pem",
    ] {
        assert!(
            !banned.is_empty() && !rendered.contains(banned),
            "leaked {banned}"
        );
    }
}
