//! Custom-provider rotation cases, split out of `web_rotation.rs` for the
//! module-size budget (ADR 0093).

use super::*;

fn oauth_def(id: &str) -> CreateCustomProvider {
    CreateCustomProvider {
        id: id.into(),
        display_name: "Acme MCP".into(),
        base_url: "https://mcp.acme.dev".into(),
        docs_url: None,
        auth: CustomAuthSpec::Oauth2AuthorizationCode {
            authorize_url: "https://mcp.acme.dev/oauth/authorize".into(),
            token_url: "https://mcp.acme.dev/oauth/token".into(),
            supports_refresh: true,
            scopes: vec!["tools:read".into()],
        },
    }
}

fn api_key_def(id: &str) -> CreateCustomProvider {
    CreateCustomProvider {
        id: id.into(),
        display_name: "Internal API".into(),
        base_url: "https://api.internal.dev/v1".into(),
        docs_url: None,
        auth: CustomAuthSpec::ApiKey {
            header: "Authorization".into(),
            value_prefix: "Bearer ".into(),
        },
    }
}

#[tokio::test]
async fn definitions_are_org_scoped_and_merge_into_the_catalog() {
    let (_db, broker) = broker().await;
    let org_a = OrganizationId::new();
    let org_b = OrganizationId::new();
    broker
        .create_custom_provider(&org_a, oauth_def("custom-acme-mcp"), "principal:admin")
        .await
        .unwrap();

    let for_a = broker.list_providers_for(&org_a).await.unwrap();
    let custom = for_a
        .iter()
        .find(|p| p.id == "custom-acme-mcp")
        .expect("custom provider listed for its org");
    assert_eq!(custom.category.as_str(), "custom");
    assert_eq!(custom.auth_kind, "oauth2_authorization_code");
    // No deployment env client exists, so the UI must offer client setup.
    assert!(!custom.configured);
    assert!(custom
        .callback_url
        .as_deref()
        .unwrap_or_default()
        .ends_with("/api/v1/oauth/callback/custom-acme-mcp"));

    let for_b = broker.list_providers_for(&org_b).await.unwrap();
    assert!(for_b.iter().all(|p| p.id != "custom-acme-mcp"));
    assert!(broker
        .list_providers()
        .unwrap()
        .iter()
        .all(|p| p.id != "custom-acme-mcp"));

    // Duplicate ids are refused.
    assert!(matches!(
        broker
            .create_custom_provider(&org_a, oauth_def("custom-acme-mcp"), "principal:admin")
            .await,
        Err(BrokerError::Invalid(_))
    ));
}

#[tokio::test]
async fn api_key_custom_connector_seals_a_key_inside_derived_egress() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    broker
        .create_custom_provider(&org, api_key_def("custom-internal"), "principal:admin")
        .await
        .unwrap();

    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                owner_subject: Some("principal:admin".into()),
                ..create("custom-internal")
            },
        )
        .await
        .unwrap();
    // The credential can only ever be attached inside the base origin.
    assert_eq!(connection.egress.scheme, "https");
    assert_eq!(connection.egress.authorities, vec!["api.internal.dev"]);
    assert_eq!(connection.egress.path_prefixes, vec!["/v1"]);

    let sealed = broker
        .set_api_key(&org, &connection.connection_id, "shhh-key")
        .await
        .unwrap();
    assert_eq!(sealed.status, ConnectionStatus::Active);
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_some());

    // In use: the definition cannot be deleted out from under it.
    assert!(matches!(
        broker.delete_custom_provider(&org, "custom-internal").await,
        Err(BrokerError::Invalid(_))
    ));
    broker
        .revoke(&org, &connection.connection_id)
        .await
        .unwrap();
    broker
        .delete_custom_provider(&org, "custom-internal")
        .await
        .unwrap();
    assert!(matches!(
        broker.delete_custom_provider(&org, "custom-internal").await,
        Err(BrokerError::ProviderUnknown(_))
    ));
}

#[tokio::test]
async fn oauth_custom_connector_authorizes_through_a_sealed_org_client() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    broker
        .create_custom_provider(&org, oauth_def("custom-acme-mcp"), "principal:admin")
        .await
        .unwrap();
    broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "custom-acme-mcp-oauth".into(),
                provider_id: "custom-acme-mcp".into(),
                display_name: "Acme MCP OAuth client".into(),
                scopes: vec!["tools:read".into()],
                client_id: Some("acme-client".into()),
                client_secret: Some("acme-secret".into()),
                configuration: BTreeMap::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();

    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                owner_subject: Some("principal:admin".into()),
                ..create("custom-acme-mcp")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    assert!(
        start
            .authorization_url
            .starts_with("https://mcp.acme.dev/oauth/authorize?"),
        "{}",
        start.authorization_url
    );
    assert!(start.authorization_url.contains("client_id=acme-client"));
}
