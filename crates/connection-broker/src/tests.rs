use chrono::Duration;
use opensesame_storage::Db;
use sqlx::Row;

use axum::{
    extract::{Form, State},
    routing::post,
    Json, Router,
};
use std::{collections::HashMap, sync::Arc};

use super::*;

const KEY: [u8; 32] = [42u8; 32];

fn key_config() -> BrokerConfig {
    let mut config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787");
    for provider in catalog::all().expect("catalog") {
        if provider.auth.is_oauth() {
            config = config.with_provider(
                &provider.id,
                ProviderConfig {
                    client_id: Some(format!("{}-client", provider.id)),
                    client_secret: Some(format!("{}-secret", provider.id)),
                    ..Default::default()
                },
            );
        }
    }
    config.with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            // Port 1 refuses immediately: these tests exercise everything around
            // the exchange without pretending to reach a provider.
            token_url: Some("http://127.0.0.1:1/token".into()),
            ..Default::default()
        },
    )
}

async fn broker_with(config: BrokerConfig) -> (Db, ConnectionBroker) {
    let db = Db::connect_memory().await.expect("db");
    let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
    (db, broker)
}

async fn broker() -> (Db, ConnectionBroker) {
    broker_with(key_config()).await
}

async fn token_server() -> String {
    token_server_with_expiry(3600).await
}

async fn token_server_with_expiry(expires_in: i64) -> String {
    async fn token(
        State(expires_in): State<i64>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Json<serde_json::Value> {
        let refreshed = form.get("grant_type").map(String::as_str) == Some("refresh_token");
        Json(serde_json::json!({
            "access_token": if refreshed { "race-access-2" } else { "race-access-1" },
            "refresh_token": if refreshed { "race-refresh-2" } else { "race-refresh-1" },
            "token_type": "Bearer",
            "expires_in": expires_in,
            "scope": "read offline_access"
        }))
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind token server");
    let address = listener.local_addr().expect("token server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/token", post(token))
                .with_state(expires_in),
        )
        .await;
    });
    format!("http://{address}/token")
}

async fn organization_oauth_broker() -> (Db, Arc<ConnectionBroker>, OrganizationId, String) {
    organization_oauth_broker_with_token_url(token_server().await).await
}

async fn organization_oauth_broker_with_token_url(
    token_url: String,
) -> (Db, Arc<ConnectionBroker>, OrganizationId, String) {
    let config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("deployment-client".into()),
            client_secret: Some("deployment-secret".into()),
            token_url: Some(token_url),
            ..Default::default()
        },
    );
    let (db, broker) = broker_with(config).await;
    let broker = Arc::new(broker);
    let organization = OrganizationId::new();
    let integration = broker
        .create_integration(
            &organization,
            CreateIntegration {
                key: "race-oauth".into(),
                provider_id: "mock".into(),
                display_name: "Race OAuth".into(),
                scopes: vec!["read".into(), "offline_access".into()],
                client_id: Some("mock-client".into()),
                client_secret: Some("mock-secret".into()),
                configuration: Default::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    (db, broker, organization, integration.id)
}

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
                configuration: Default::default(),
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
                configuration: Default::default(),
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
                configuration: Default::default(),
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
async fn legacy_connection_is_pinned_before_authorization() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:mock".into()),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    sqlx::query("UPDATE connections SET integration_id = NULL WHERE id = ?")
        .bind(&view.connection_id)
        .execute(db.pool())
        .await
        .unwrap();
    broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap();
    broker
        .create_integration(
            &org,
            CreateIntegration {
                key: "other".into(),
                provider_id: "mock".into(),
                display_name: "Other mock".into(),
                scopes: vec!["read".into()],
                client_id: Some("other-client".into()),
                client_secret: Some("other-secret".into()),
                configuration: Default::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    let pinned: Option<String> = sqlx::query("SELECT integration_id FROM connections WHERE id = ?")
        .bind(&view.connection_id)
        .fetch_one(db.pool())
        .await
        .unwrap()
        .get(0);
    assert_eq!(pinned.as_deref(), Some("deployment:mock"));
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
                configuration: Default::default(),
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
async fn ambiguous_legacy_connection_can_always_revoke_locally() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:stripe".into()),
                ..create("stripe")
            },
        )
        .await
        .unwrap();
    broker
        .set_api_key(&org, &connection.connection_id, "secret")
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
                key: "second-stripe".into(),
                provider_id: "stripe".into(),
                display_name: "Second Stripe".into(),
                scopes: Vec::new(),
                client_id: None,
                client_secret: None,
                configuration: Default::default(),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        broker
            .revoke(&org, &connection.connection_id)
            .await
            .unwrap()
            .revoked
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn stale_unknown_provider_can_always_revoke_locally() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &connection.connection_id, "secret")
        .await
        .unwrap();
    sqlx::query("UPDATE connections SET provider_id = 'removed-provider' WHERE id = ?")
        .bind(&connection.connection_id)
        .execute(db.pool())
        .await
        .unwrap();
    let outcome = broker
        .revoke(&org, &connection.connection_id)
        .await
        .unwrap();
    assert!(outcome.revoked);
    assert_eq!(outcome.provider_revocation, ProviderRevocation::Unsupported);
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
        ConnectionStatus::Revoked
    );
}

#[tokio::test]
async fn revoke_invalidates_late_callback_and_cas_key_writes() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let oauth = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:mock".into()),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &oauth.connection_id, None, None)
        .await
        .unwrap();
    broker.revoke(&org, &oauth.connection_id).await.unwrap();
    assert_eq!(
        broker
            .complete_authorization("mock", "late-code", &start.state)
            .await
            .unwrap_err()
            .code(),
        "invalid_state"
    );

    let api = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:stripe".into()),
                ..create("stripe")
            },
        )
        .await
        .unwrap();
    broker.revoke(&org, &api.connection_id).await.unwrap();
    assert_eq!(
        broker
            .set_api_key(&org, &api.connection_id, "late-key")
            .await
            .unwrap_err()
            .code(),
        "invalid_request"
    );
    assert!(store::get_credential(db.pool(), &api.connection_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .get_connection(&org, &api.connection_id)
            .await
            .unwrap()
            .status,
        ConnectionStatus::Revoked
    );
}

#[tokio::test]
async fn lowered_scope_ceiling_after_exchange_cleans_issued_tokens_and_local_credentials() {
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
    let pause = TestActivationPause::new();
    broker.pause_next_activation(pause.clone());
    let completing = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "race-code", &start.state)
                .await
        })
    };
    pause.wait_until_reached().await;
    broker
        .update_integration(
            &org,
            &integration_id,
            UpdateIntegration {
                scopes: Some(vec!["read".into()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    pause.resume();
    assert_eq!(
        completing.await.unwrap().unwrap_err().code(),
        "integration_conflict"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
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
        ConnectionStatus::Error
    );
}

#[tokio::test]
async fn invalid_provider_expiry_cleans_issued_tokens_without_storing_them() {
    let (db, broker, org, integration_id) =
        organization_oauth_broker_with_token_url(token_server_with_expiry(-1).await).await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    assert_eq!(
        broker
            .complete_authorization("mock", "invalid-expiry", &start.state)
            .await
            .unwrap_err()
            .code(),
        "exchange_failed"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
    );
    assert!(store::get_credential(db.pool(), &connection.connection_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn revoke_winning_activation_cleans_issued_tokens_and_stays_terminal() {
    let (db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let pause = TestActivationPause::new();
    broker.pause_next_activation(pause.clone());
    let completing = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "race-code", &start.state)
                .await
        })
    };
    pause.wait_until_reached().await;
    broker
        .revoke(&org, &connection.connection_id)
        .await
        .unwrap();
    pause.resume();
    assert_eq!(
        completing.await.unwrap().unwrap_err().code(),
        "invalid_request"
    );
    assert_eq!(
        broker.take_cleanup_attempts(),
        ["race-refresh-1", "race-access-1"]
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
        ConnectionStatus::Revoked
    );
}

#[tokio::test]
async fn overlapping_authorizations_activate_one_generation_and_clean_the_loser() {
    let (_db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let first = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let second = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    let first_task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "code-one", &first.state)
                .await
        })
    };
    let second_task = {
        let broker = broker.clone();
        tokio::spawn(async move {
            broker
                .complete_authorization("mock", "code-two", &second.state)
                .await
        })
    };
    let first_result = first_task.await.unwrap();
    let second_result = second_task.await.unwrap();
    assert!(first_result.is_ok(), "{first_result:?}");
    assert!(second_result.is_ok(), "{second_result:?}");
    assert_eq!(broker.take_cleanup_attempts().len(), 2);
    assert_eq!(
        broker
            .events(&org, &connection.connection_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "authorized")
            .count(),
        1
    );
}

#[tokio::test]
async fn concurrent_successful_refreshes_activate_one_generation_and_clean_the_loser() {
    let (_db, broker, org, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
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
    let pause = TestActivationPause::for_responses(2);
    broker.pause_next_refreshes(pause.clone());
    let refresh = || {
        let broker = broker.clone();
        let organization = org;
        let connection_id = connection.connection_id.clone();
        tokio::spawn(async move { broker.refresh(&organization, &connection_id).await })
    };
    let first = refresh();
    let second = refresh();
    pause.wait_until_reached().await;
    pause.resume();
    assert!(first.await.unwrap().is_ok());
    assert!(second.await.unwrap().is_ok());
    assert_eq!(broker.take_cleanup_attempts().len(), 2);
    assert_eq!(
        broker
            .events(&org, &connection.connection_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == "refreshed")
            .count(),
        1
    );
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
async fn provider_error_consumes_state_once() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some("deployment:mock".into()),
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
        .reject_authorization("mock", &start.state, "access denied")
        .await
        .unwrap();
    assert_eq!(
        broker
            .reject_authorization("mock", &start.state, "again")
            .await
            .unwrap_err()
            .code(),
        "invalid_state"
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
                configuration: Default::default(),
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

fn create(provider_id: &str) -> CreateConnection {
    CreateConnection {
        provider_id: provider_id.into(),
        integration_id: None,
        display_name: None,
        logical_name: None,
        project_id: None,
        scopes: None,
        shareability: None,
        owner_subject: None,
    }
}

/// sqlx gives each in-memory pool its own database; the tests below rely on it.
#[tokio::test]
async fn separate_in_memory_databases_do_not_share_state() {
    let (_a_db, a) = broker().await;
    let (_b_db, b) = broker().await;
    let org = OrganizationId::new();
    a.create_connection(&org, create("mock")).await.unwrap();
    assert_eq!(a.list_connections(&org).await.unwrap().len(), 1);
    assert!(b.list_connections(&org).await.unwrap().is_empty());
}

#[tokio::test]
async fn without_a_key_no_provider_is_configured() {
    let (_db, broker) = broker_with(BrokerConfig::in_memory(None, "http://127.0.0.1:8787")).await;
    let providers = broker.list_providers().unwrap();
    assert_eq!(providers.len(), catalog::all().unwrap().len());
    for p in &providers {
        assert!(!p.configured, "{} claimed configured", p.id);
        assert!(p
            .missing_config
            .contains(&config::ENV_CONNECTION_KEY.to_string()));
    }
}

#[tokio::test]
async fn a_created_connection_is_pending_and_named() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();

    assert_eq!(view.status, ConnectionStatus::Pending);
    assert_eq!(view.provider_id, "github");
    assert_eq!(view.logical_name, "github/main");
    assert!(view.connection_ref.starts_with("conn://"));
    assert!(view.connection_ref.ends_with("github/main"));
    assert_eq!(view.requested_scopes, vec!["read:user".to_string()]);
    assert_eq!(view.egress.authorities, vec!["api.github.com".to_string()]);
    assert_eq!(view.max_invoke_level, 2);
    assert!(!view.refreshable);
    assert!(view.bindings.is_empty());
}

#[tokio::test]
async fn a_project_scoped_connection_keeps_the_project_in_its_ref() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let project = ProjectId::new();
    let view = broker
        .create_connection(
            &org,
            CreateConnection {
                project_id: Some(project.to_string()),
                ..create("github")
            },
        )
        .await
        .unwrap();
    assert!(view.connection_ref.contains(&project.to_string()));
    assert_eq!(
        view.project_id.as_deref(),
        Some(project.to_string().as_str())
    );
}

#[tokio::test]
async fn a_second_connection_to_the_same_provider_gets_its_own_name() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let first = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();
    let second = broker
        .create_connection(&org, create("github"))
        .await
        .unwrap();
    assert_eq!(first.logical_name, "github/main");
    assert_eq!(second.logical_name, "github/main-2");

    let taken = broker
        .create_connection(
            &org,
            CreateConnection {
                logical_name: Some("github/main".into()),
                ..create("github")
            },
        )
        .await
        .unwrap_err();
    assert_eq!(taken.code(), "invalid_request");
}

#[tokio::test]
async fn an_unknown_provider_is_refused() {
    let (_db, broker) = broker().await;
    let err = broker
        .create_connection(&OrganizationId::new(), create("myspace"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unknown");
}

#[tokio::test]
async fn another_organizations_connection_reads_as_absent() {
    let (_db, broker) = broker().await;
    let mine = OrganizationId::new();
    let theirs = OrganizationId::new();
    let view = broker
        .create_connection(&mine, create("mock"))
        .await
        .unwrap();

    let err = broker
        .get_connection(&theirs, &view.connection_id)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "connection_not_found");
    assert!(broker.list_connections(&theirs).await.unwrap().is_empty());
}

#[tokio::test]
async fn authorize_refuses_a_provider_the_deployment_cannot_use() {
    let (_db, broker) =
        broker_with(BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787")).await;
    let err = broker
        .create_connection(&OrganizationId::new(), create("github"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "integration_not_found");
}

#[tokio::test]
async fn authorize_refuses_before_a_consent_it_could_not_store() {
    let config = BrokerConfig::in_memory(None, "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            ..Default::default()
        },
    );
    let (_db, broker) = broker_with(config).await;
    let org = OrganizationId::new();
    let err = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "integration_not_found");
}

#[tokio::test]
async fn authorize_returns_a_pkce_bound_url() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, Some(vec!["read".into()]))
        .await
        .unwrap();

    let url = url::Url::parse(&start.authorization_url).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["state"], start.state);
    assert_eq!(q["scope"], "read");
    assert_eq!(
        q["redirect_uri"],
        "http://127.0.0.1:8787/api/v1/oauth/callback/mock"
    );
    assert!(!q["code_challenge"].is_empty());
    // The verifier itself must never appear in what the browser is handed.
    assert!(!start.authorization_url.contains("code_verifier"));
    let stored = sqlx::query(
        "SELECT state, code_verifier, verifier_nonce FROM connection_authorizations WHERE connection_id = ?",
    )
    .bind(&view.connection_id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    let stored_state: String = stored.get("state");
    assert_ne!(stored_state, start.state);
    assert_eq!(stored_state.len(), 64);
    assert_eq!(stored.get::<Vec<u8>, _>("verifier_nonce").len(), 24);
    assert!(!stored.get::<Vec<u8>, _>("code_verifier").is_empty());

    let events = broker.events(&org, &view.connection_id).await.unwrap();
    assert_eq!(
        events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        vec!["created", "authorize_started"]
    );
}

#[tokio::test]
async fn a_replayed_state_is_rejected() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap();

    // The exchange cannot reach the (deliberately dead) token endpoint, but the
    // state is consumed regardless: a code arriving twice must not be tried twice.
    let first = broker
        .complete_authorization("mock", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(first.code(), "exchange_failed");

    let replay = broker
        .complete_authorization("mock", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(replay.code(), "invalid_state");

    let unknown = broker
        .complete_authorization("mock", "code-1", "never-issued")
        .await
        .unwrap_err();
    assert_eq!(unknown.code(), "invalid_state");
}

#[tokio::test]
async fn an_expired_state_is_rejected() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    store::insert_authorization(
        db.pool(),
        &store::AuthorizationRow {
            state: "stale-state".into(),
            connection_id: view.connection_id.clone(),
            code_verifier: crypto::seal(&KEY, &view.connection_id, &org.to_string(), b"verifier")
                .unwrap(),
            redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/mock".into(),
            scopes: vec!["read".into()],
            expires_at: Utc::now() - Duration::seconds(1),
            credential_version: None,
        },
    )
    .await
    .unwrap();

    let err = broker
        .complete_authorization("mock", "code-1", "stale-state")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "state_expired");

    // Expiry is terminal, and it takes the verifier with it.
    let again = broker
        .complete_authorization("mock", "code-1", "stale-state")
        .await
        .unwrap_err();
    assert_eq!(again.code(), "invalid_state");
}

#[tokio::test]
async fn a_state_belongs_to_the_provider_that_issued_it() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap();
    let err = broker
        .complete_authorization("github", "code-1", &start.state)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_state");
}

#[tokio::test]
async fn a_redirect_off_the_allowlist_is_refused() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let err = broker
        .start_authorization(
            &org,
            &view.connection_id,
            Some("https://evil.example/steal".into()),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "redirect_not_allowed");
}

#[tokio::test]
async fn an_api_key_connection_activates_without_a_consent_screen() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "unsupported_credential");

    let active = broker
        .set_api_key(&org, &view.connection_id, "sk_test_do_not_leak")
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert_eq!(
        active.configured_fields,
        vec![ConfiguredFieldView {
            name: "api_key".into(),
            hint: Some("configured".into()),
        }]
    );
    assert!(!active.refreshable);
    assert!(active.expires_at.is_none());

    let rendered = serde_json::to_string(&active).unwrap();
    assert!(!rendered.contains("sk_test_do_not_leak"));

    let refresh = broker.refresh(&org, &view.connection_id).await.unwrap_err();
    assert_eq!(refresh.code(), "not_refreshable");

    let empty = broker
        .set_api_key(&org, &view.connection_id, "   ")
        .await
        .unwrap_err();
    assert_eq!(empty.code(), "invalid_request");

    let cleared = broker
        .set_connection_configuration(
            &org,
            &view.connection_id,
            Default::default(),
            vec!["api_key".into()],
        )
        .await
        .unwrap();
    assert_eq!(cleared.status, ConnectionStatus::Pending);
    assert!(cleared.configured_fields.is_empty());
}

#[tokio::test]
async fn a_fnox_provider_seals_its_declared_configuration() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("azure-sm"))
        .await
        .unwrap();

    let active = broker
        .set_connection_configuration(
            &org,
            &view.connection_id,
            std::collections::BTreeMap::from([
                (
                    "vault_url".into(),
                    "https://example.vault.azure.net/".into(),
                ),
                ("tenant_id".into(), "tenant-1234".into()),
                ("client_id".into(), "client-1234".into()),
                ("client_secret".into(), "do-not-return".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();

    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(active
        .configured_fields
        .iter()
        .any(|field| field.name == "client_secret" && field.hint.as_deref() == Some("configured")));
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("do-not-return"));
}

#[tokio::test]
async fn an_oauth_provider_refuses_a_pasted_api_key() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();
    let err = broker
        .set_api_key(&org, &view.connection_id, "whatever")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "unsupported_credential");
}

#[tokio::test]
async fn revoking_keeps_the_row_and_drops_the_credential() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_x")
        .await
        .unwrap();

    let outcome = broker.revoke(&org, &view.connection_id).await.unwrap();
    assert!(outcome.revoked);
    assert_eq!(outcome.provider_revocation, ProviderRevocation::Unsupported);

    let after = broker
        .get_connection(&org, &view.connection_id)
        .await
        .unwrap();
    assert_eq!(after.status, ConnectionStatus::Revoked);
    assert!(store::get_credential(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .is_none());

    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_request");
}

#[tokio::test]
async fn bindings_are_unique_per_target_and_removable() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    let bound = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Agent,
                target_id: "agent:1".into(),
                target_label: Some("release bot".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(bound.bindings.len(), 1);
    assert_eq!(bound.bindings[0].target_kind, BindingTargetKind::Agent);

    let duplicate = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Agent,
                target_id: "agent:1".into(),
                target_label: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(duplicate.code(), "binding_exists");

    let unbound = broker
        .unbind(&org, &view.connection_id, &bound.bindings[0].id)
        .await
        .unwrap();
    assert!(unbound.bindings.is_empty());

    let missing = broker
        .unbind(&org, &view.connection_id, "not-a-binding")
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "binding_not_found");
}

#[tokio::test]
async fn every_mutation_leaves_an_event() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_x")
        .await
        .unwrap();
    let bound = broker
        .bind(
            &org,
            &view.connection_id,
            BindRequest {
                target_kind: BindingTargetKind::Project,
                target_id: "project:1".into(),
                target_label: None,
            },
        )
        .await
        .unwrap();
    broker
        .unbind(&org, &view.connection_id, &bound.bindings[0].id)
        .await
        .unwrap();
    broker.revoke(&org, &view.connection_id).await.unwrap();

    let kinds: Vec<_> = broker
        .events(&org, &view.connection_id)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        vec!["created", "authorized", "bound", "unbound", "revoked"]
    );
}

/// The stored credential is sealed, so the row is useless without the key — and
/// useless with the key under another tenant's ids.
#[tokio::test]
async fn a_stored_credential_is_unreadable_in_the_database() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_do_not_leak")
        .await
        .unwrap();

    let credential = store::get_credential(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .expect("credential");
    let raw = String::from_utf8_lossy(&credential.sealed.ciphertext).to_string();
    assert!(!raw.contains("sk_test_do_not_leak"));
    assert!(crypto::open(
        &KEY,
        &view.connection_id,
        &OrganizationId::new().to_string(),
        &credential.sealed
    )
    .is_err());
    let opened = crypto::open(
        &KEY,
        &view.connection_id,
        &org.to_string(),
        &credential.sealed,
    )
    .unwrap();
    let tokens: token::TokenSet = serde_json::from_slice(&opened).unwrap();
    assert_eq!(tokens.access_token, "sk_test_do_not_leak");
}

/// One gateway serves many callers out of a single organization, so listing has
/// to be able to answer for one of them: an owner sees its own connection and
/// nobody else's, and an unowned row belongs to no session at all.
#[tokio::test]
async fn listing_can_be_narrowed_to_one_owner() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let mut mine = create("stripe");
    mine.owner_subject = Some("user:alice".into());
    let mine = broker.create_connection(&org, mine).await.unwrap();
    let mut theirs = create("stripe");
    theirs.owner_subject = Some("user:bob".into());
    let theirs = broker.create_connection(&org, theirs).await.unwrap();
    let unowned = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();

    let alice = broker
        .list_connections_for(&org, Some("user:alice"))
        .await
        .unwrap();
    assert_eq!(
        alice
            .iter()
            .map(|c| c.connection_id.clone())
            .collect::<Vec<_>>(),
        vec![mine.connection_id.clone()]
    );
    assert_eq!(
        broker
            .owner_subject(&org, &theirs.connection_id)
            .await
            .unwrap(),
        Some("user:bob".to_string())
    );
    assert_eq!(
        broker
            .owner_subject(&org, &unowned.connection_id)
            .await
            .unwrap(),
        None
    );
    // Unnarrowed still means the whole organization.
    assert_eq!(broker.list_connections(&org).await.unwrap().len(), 3);
}

/// A provider that rotates refresh tokens rejects the older one, so the loser of
/// two simultaneous refreshes is told a live grant is gone. It must read the
/// tokens on record before believing that.
#[tokio::test]
async fn a_refresh_that_lost_a_race_does_not_report_reauth() {
    let (db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("stripe"))
        .await
        .unwrap();
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_first")
        .await
        .unwrap();
    let row = store::get_connection(db.pool(), &view.connection_id)
        .await
        .unwrap()
        .expect("row");
    let stale = token::TokenSet {
        access_token: "sk_test_first".into(),
        refresh_token: None,
        token_type: "api_key".into(),
        expires_at: None,
        scopes: Vec::new(),
        configuration: Default::default(),
    };
    // What is on record is still what this refresh read, so a rejection would be
    // the connection's own news.
    assert!(!broker.credential_moved_on(&KEY, &row, &stale).await);
    broker
        .set_api_key(&org, &view.connection_id, "sk_test_second")
        .await
        .unwrap();
    // Someone else has since written newer tokens: this failure is not about them.
    assert!(broker.credential_moved_on(&KEY, &row, &stale).await);
}
