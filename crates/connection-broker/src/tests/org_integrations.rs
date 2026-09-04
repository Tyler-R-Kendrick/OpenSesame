//! Organization integrations: sealing, scope ceilings, disable and delete.

use super::*;

#[tokio::test]
async fn configured_deployment_apps_are_shared_dev_integrations() {
    let (_db, broker) = broker().await;
    let integrations = broker
        .list_integrations(&OrganizationId::new())
        .await
        .unwrap();
    let github = integrations
        .iter()
        .find(|integration| integration.provider_id == "github")
        .expect("github integration");
    assert_eq!(github.source, IntegrationSource::SharedDev);
    assert_eq!(
        serde_json::to_value(github).unwrap()["source"],
        "shared_dev"
    );
    assert_eq!(
        github.callback_url.as_deref(),
        Some("http://127.0.0.1:8787/api/v1/oauth/callback/github")
    );
}

#[tokio::test]
async fn organization_integrations_seal_secrets_and_enforce_scope_ceiling() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let integration = broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "engineering".into(),
                provider_id: "github".into(),
                display_name: "Engineering GitHub".into(),
                scopes: vec!["read:user".into()],
                client_id: Some("client-id".into()),
                client_secret: Some("plain-secret".into()),
                configuration: BTreeMap::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    assert!(integration.configured);
    assert!(integration.has_client_secret);
    assert_eq!(integration.client_id_hint.as_deref(), Some("***t-id"));
    assert_eq!(
        integration.configured_fields,
        vec![
            ConfiguredFieldView {
                name: "client_id".into(),
                hint: Some("***t-id".into()),
            },
            ConfiguredFieldView {
                name: "client_secret".into(),
                hint: Some("configured".into()),
            },
        ]
    );

    let stored = sqlx::query("SELECT client_id, client_secret_ciphertext, configuration_ciphertext FROM integrations WHERE id = ?")
        .bind(&integration.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert!(stored.get::<Option<String>, _>("client_id").is_none());
    assert!(stored
        .get::<Option<Vec<u8>>, _>("client_secret_ciphertext")
        .is_none());
    assert_ne!(
        stored.get::<Vec<u8>, _>("configuration_ciphertext"),
        b"plain-secret"
    );

    let error = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some(integration.id.clone()),
                scopes: Some(vec!["repo".into()]),
                ..create("github")
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_request");

    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some(integration.id),
                ..create("github")
            },
        )
        .await
        .unwrap();
    let error = broker
        .start_authorization(
            &org,
            &connection.connection_id,
            None,
            Some(vec!["repo".into()]),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_request");
}

#[tokio::test]
async fn organization_integration_configuration_supports_set_and_clear() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let integration = broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "field-map".into(),
                provider_id: "github".into(),
                display_name: "Field map".into(),
                scopes: vec!["read:user".into()],
                client_id: None,
                client_secret: None,
                configuration: std::collections::BTreeMap::from([
                    ("client_id".into(), "map-client".into()),
                    ("client_secret".into(), "map-secret".into()),
                ]),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    assert!(integration.configured);

    let cleared = broker
        .update_integration(
            &org,
            &integration.id,
            UpdateIntegration {
                configuration_clear: vec!["client_secret".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!cleared.configured);
    assert_eq!(cleared.configured_fields.len(), 1);

    let restored = broker
        .update_integration(
            &org,
            &integration.id,
            UpdateIntegration {
                configuration_set: std::collections::BTreeMap::from([(
                    "client_secret".into(),
                    "rotated".into(),
                )]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(restored.configured);
    assert!(!serde_json::to_string(&restored)
        .unwrap()
        .contains("rotated"));
}

#[tokio::test]
async fn disabled_api_key_integration_blocks_credentials_and_delete_is_guarded() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let integration = broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "billing".into(),
                provider_id: "stripe".into(),
                display_name: "Billing".into(),
                scopes: Vec::new(),
                client_id: None,
                client_secret: None,
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
                integration_id: Some(integration.id.clone()),
                ..create("stripe")
            },
        )
        .await
        .unwrap();
    broker
        .update_integration(
            &org,
            &integration.id,
            UpdateIntegration {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        broker
            .set_api_key(&org, &connection.connection_id, "sk_test")
            .await
            .unwrap_err()
            .code(),
        "integration_not_found"
    );
    assert_eq!(
        broker
            .delete_integration(&org, &integration.id)
            .await
            .unwrap_err()
            .code(),
        "integration_in_use"
    );
}

#[tokio::test]
async fn concurrent_integration_patches_preserve_disable_and_secret_rotation() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let integration = broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "concurrent-patch".into(),
                provider_id: "mock".into(),
                display_name: "Concurrent patch".into(),
                scopes: vec!["read".into()],
                client_id: Some("client".into()),
                client_secret: Some("old-secret".into()),
                configuration: BTreeMap::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    let (disabled, rotated) = tokio::join!(
        broker.update_integration(
            &org,
            &integration.id,
            UpdateIntegration {
                enabled: Some(false),
                ..Default::default()
            },
        ),
        broker.update_integration(
            &org,
            &integration.id,
            UpdateIntegration {
                client_secret: Some("new-secret".into()),
                ..Default::default()
            },
        )
    );
    disabled.unwrap();
    rotated.unwrap();

    let view = broker.get_integration(&org, &integration.id).await.unwrap();
    assert!(!view.enabled);
    let stored = sqlx::query("SELECT configuration_ciphertext, configuration_nonce, configuration_aad_digest FROM integrations WHERE id = ?")
        .bind(&integration.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    let opened = crypto::open(
        &KEY,
        &integration.id,
        &org.to_string(),
        &crypto::SealedBlob {
            ciphertext: stored.get("configuration_ciphertext"),
            nonce: stored.get("configuration_nonce"),
            aad_digest: stored.get("configuration_aad_digest"),
        },
    )
    .unwrap();
    let configuration: std::collections::BTreeMap<String, String> =
        serde_json::from_slice(&opened).unwrap();
    assert_eq!(configuration["client_secret"], "new-secret");
}

#[tokio::test]
async fn integration_delete_is_guarded_and_counts_are_tenant_scoped() {
    let (_db, broker) = broker().await;
    let first = OrganizationId::new();
    let second = OrganizationId::new();
    let view = broker
        .create_connection(
            &first,
            CreateConnection {
                integration_id: Some("deployment:github".into()),
                ..create("github")
            },
        )
        .await
        .unwrap();
    assert_eq!(view.integration_id.as_deref(), Some("deployment:github"));
    let first_count = broker
        .get_integration(&first, "deployment:github")
        .await
        .unwrap()
        .connection_count;
    let second_count = broker
        .get_integration(&second, "deployment:github")
        .await
        .unwrap()
        .connection_count;
    assert_eq!((first_count, second_count), (1, 0));
    assert_eq!(
        broker
            .delete_integration(&first, "deployment:github")
            .await
            .unwrap_err()
            .code(),
        "integration_read_only"
    );
}

#[tokio::test]
async fn ambiguous_legacy_connections_remain_readable_with_null_integration() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:github".into()),
                ..create("github")
            },
        )
        .await
        .unwrap();
    sqlx::query("UPDATE connections SET integration_id = NULL WHERE id = ?")
        .bind(&connection.connection_id)
        .execute(db.pool())
        .await
        .unwrap();
    broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "second".into(),
                provider_id: "github".into(),
                display_name: "Second".into(),
                scopes: vec!["read:user".into()],
                client_id: Some("second-client".into()),
                client_secret: Some("second-secret".into()),
                configuration: BTreeMap::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    let listed = broker.list_connections(&org).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].integration_id, None);
}

#[tokio::test]
async fn integration_change_after_refresh_cleans_rotated_tokens_and_old_credential() {
    let (db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id.clone()),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    broker
        .complete_authorization("mock", "initial-code", &start.state)
        .await
        .unwrap();
    assert!(broker.take_cleanup_attempts().is_empty());

    let pause = TestActivationPause::new();
    broker.pause_next_activation(pause.clone());
    let refreshing = {
        let broker = broker.clone();
        let organization = org;
        let connection_id = connection.connection_id.clone();
        tokio::spawn(async move { broker.refresh(&organization, &connection_id).await })
    };
    pause.wait_until_reached().await;
    broker
        .update_integration(
            &org,
            &integration_id,
            UpdateIntegration {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    pause.resume();
    assert_eq!(
        refreshing.await.unwrap().unwrap_err().code(),
        "needs_reauth"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-2", "race-access-2"]
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .get_connection(&org, &connection.connection_id)
            .await
            .unwrap()
            .status,
        ConnectionStatus::NeedsReauth
    );
}

#[tokio::test]
async fn concurrent_connection_create_and_integration_delete_never_orphan() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let integration = broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "race".into(),
                provider_id: "stripe".into(),
                display_name: "Race".into(),
                scopes: Vec::new(),
                client_id: None,
                client_secret: None,
                configuration: BTreeMap::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    let request = CreateConnection {
        integration_id: Some(integration.id.clone()),
        ..create("stripe")
    };
    let (created, deleted) = tokio::join!(
        broker.create_connection(&org, request),
        broker.delete_integration(&org, &integration.id)
    );
    match (&created, &deleted) {
        (Ok(_), Err(error)) => assert_eq!(error.code(), "integration_in_use"),
        (Err(error), Ok(())) => assert_eq!(error.code(), "integration_not_found"),
        other => panic!("unexpected race outcome: {other:?}"),
    }
    let orphan_count = sqlx::query(
        "SELECT COUNT(*) AS n FROM connections c LEFT JOIN integrations i ON i.id = c.integration_id AND i.organization_id = c.organization_id WHERE c.integration_id NOT LIKE 'deployment:%' AND i.id IS NULL",
    )
    .fetch_one(db.pool())
    .await
    .unwrap()
    .get::<i64, _>("n");
    assert_eq!(orphan_count, 0);
}
