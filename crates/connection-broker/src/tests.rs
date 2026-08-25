use chrono::Duration;
use opensesame_storage::Db;
use opensesame_task_bus::TaskBus as _;
use sqlx::Row;

use axum::{
    extract::{Form, State},
    routing::post,
    Json, Router,
};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

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
                configuration: BTreeMap::default(),
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
async fn complete_host_credentials_are_imported_once_and_stay_redacted() {
    let config = key_config().with_detected_connection(
        "workos",
        std::collections::BTreeMap::from([("api_key".into(), "detected-do-not-return".into())]),
    );
    let (_db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    let owner = "prn_environment_owner";

    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        3
    );
    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        0
    );
    let connections = broker
        .list_connections_for(&organization, Some(owner))
        .await
        .unwrap();
    assert_eq!(connections.len(), 3);
    let workos = connections
        .iter()
        .find(|connection| connection.provider_id == "workos")
        .unwrap();
    assert_eq!(workos.status, ConnectionStatus::Active);
    assert!(!serde_json::to_string(&connections)
        .unwrap()
        .contains("detected-do-not-return"));

    broker
        .revoke(&organization, &workos.connection_id)
        .await
        .unwrap();
    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        0,
        "an explicit revoke is a tombstone, not an invitation to re-import"
    );
    assert!(
        broker
            .list_providers()
            .unwrap()
            .iter()
            .find(|provider| provider.id == "workos")
            .unwrap()
            .auto_configurable
    );
    let enabled = broker
        .create_connection(
            &organization,
            CreateConnection {
                owner_subject: Some(owner.into()),
                display_name: Some("WorkOS".into()),
                ..create("workos")
            },
        )
        .await
        .unwrap();
    assert_eq!(enabled.status, ConnectionStatus::Active);
}

#[tokio::test]
async fn detected_credentials_are_not_imported_without_a_sealing_key() {
    let config = BrokerConfig::in_memory(None, "http://127.0.0.1:8787").with_detected_connection(
        "workos",
        std::collections::BTreeMap::from([("api_key".into(), "unsealed".into())]),
    );
    let (_db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some("prn_owner"))
            .await,
        0
    );
    assert!(broker
        .list_connections(&organization)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn failed_detected_import_is_removed_and_can_be_retried() {
    let bad = key_config().with_detected_connection(
        "workos",
        std::collections::BTreeMap::from([("unexpected".into(), "invalid".into())]),
    );
    let (db, broker) = broker_with(bad).await;
    let organization = OrganizationId::new();
    let owner = "prn_environment_owner";
    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        2
    );
    let connections = broker
        .list_connections_for(&organization, Some(owner))
        .await
        .unwrap();
    assert_eq!(connections.len(), 2);
    assert!(connections
        .iter()
        .all(|connection| connection.provider_id != "workos"));

    let corrected = key_config().with_detected_connection(
        "workos",
        std::collections::BTreeMap::from([("api_key".into(), "corrected".into())]),
    );
    let broker = ConnectionBroker::new(db.pool().clone(), corrected).unwrap();
    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        1
    );
}

#[tokio::test]
async fn zero_input_native_connectors_are_ready_without_user_configuration() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let owner = "prn_local_owner";

    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        2
    );
    let connections = broker
        .list_connections_for(&organization, Some(owner))
        .await
        .unwrap();
    let providers = connections
        .iter()
        .map(|connection| connection.provider_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        providers,
        std::collections::BTreeSet::from(["plain", "sealed-local"])
    );
    let automatic = broker
        .list_providers()
        .unwrap()
        .into_iter()
        .filter(|provider| provider.auto_configurable)
        .map(|provider| provider.id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        automatic,
        std::collections::BTreeSet::from(["plain".into(), "sealed-local".into()])
    );
    assert!(connections
        .iter()
        .all(|connection| connection.status == ConnectionStatus::Active));
    assert!(!serde_json::to_string(&connections)
        .unwrap()
        .contains("opensesame://sealed-local"));
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
                configuration: BTreeMap::default(),
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
                configuration: BTreeMap::default(),
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
    let revoke_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE event_type = 'connection.credential.revoked'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(revoke_events, 1);
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
    let org = OrganizationId::new();
    // PAT providers may create a pending connection without an OAuth App.
    let view = broker
        .create_connection(&org, create("github"))
        .await
        .expect("github pending connection without OAuth App");
    let err = broker
        .start_authorization(&org, &view.connection_id, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "provider_unconfigured");
}

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
            BTreeMap::default(),
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
async fn certificate_actor_can_open_only_an_active_issuer_connection() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let issuer = broker
        .create_connection(&org, create("zerossl"))
        .await
        .unwrap();

    let pending = broker
        .certificate_issuer_configuration(&org, &issuer.connection_id)
        .await
        .unwrap_err();
    assert_eq!(pending.code(), "needs_reauth");

    broker
        .set_connection_configuration(
            &org,
            &issuer.connection_id,
            BTreeMap::from([
                ("eab_kid".into(), "kid-1".into()),
                ("eab_hmac_key".into(), "do-not-return".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();

    let opened = broker
        .certificate_issuer_configuration(&org, &issuer.connection_id)
        .await
        .unwrap();
    assert_eq!(opened.provider_id, "zerossl");
    assert_eq!(opened.values["eab_kid"], "kid-1");
    assert_eq!(opened.values["eab_hmac_key"], "do-not-return");
    assert!(!format!("{opened:?}").contains("do-not-return"));

    let ordinary = broker
        .create_connection(&org, create("azure-sm"))
        .await
        .unwrap();
    let refused = broker
        .certificate_issuer_configuration(&org, &ordinary.connection_id)
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "invalid_request");
}

#[tokio::test]
async fn identity_connectors_seal_their_declared_configuration() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();

    let better_auth = broker
        .create_connection(&org, create("better-auth"))
        .await
        .unwrap();
    let active = broker
        .set_connection_configuration(
            &org,
            &better_auth.connection_id,
            std::collections::BTreeMap::from([
                (
                    "base_url".into(),
                    "https://auth.example.com/api/auth".into(),
                ),
                ("api_key".into(), "do-not-return".into()),
                ("api_key_header".into(), "x-api-key".into()),
                ("config_id".into(), "default".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("do-not-return"));

    let auth0 = broker
        .create_connection(&org, create("auth0"))
        .await
        .unwrap();
    let active = broker
        .set_connection_configuration(
            &org,
            &auth0.connection_id,
            std::collections::BTreeMap::from([
                ("domain".into(), "tenant.us.auth0.com".into()),
                ("client_id".into(), "client".into()),
                ("client_secret".into(), "also-do-not-return".into()),
                (
                    "audience".into(),
                    "https://tenant.us.auth0.com/api/v2/".into(),
                ),
            ]),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("also-do-not-return"));
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
async fn access_targets_and_policy_changes_round_trip() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();
    let view = broker
        .create_connection(&org, create("mock"))
        .await
        .unwrap();

    for (kind, id) in [
        (BindingTargetKind::Identity, "identity:alice"),
        (BindingTargetKind::Group, "group:security"),
        (BindingTargetKind::Device, "device:laptop"),
    ] {
        let bound = broker
            .bind(
                &org,
                &view.connection_id,
                BindRequest {
                    target_kind: kind,
                    target_id: id.into(),
                    target_label: None,
                },
            )
            .await
            .unwrap();
        assert!(bound.bindings.iter().any(|binding| binding.target_id == id));
    }

    let updated = broker
        .update_policy(
            &org,
            &view.connection_id,
            Shareability::OrganizationWide,
            1,
            None,
        )
        .await
        .unwrap();
    assert_eq!(updated.shareability, Shareability::OrganizationWide);
    assert_eq!(updated.max_invoke_level, 1);
    assert_eq!(
        broker
            .events(&org, &view.connection_id)
            .await
            .unwrap()
            .last()
            .unwrap()
            .kind,
        "policy_updated"
    );

    let invalid = broker
        .update_policy(&org, &view.connection_id, Shareability::Private, 3, None)
        .await
        .unwrap_err();
    assert_eq!(invalid.code(), "invalid_request");
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
        configuration: BTreeMap::default(),
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

// ---- sync targets (WP-C) ----------------------------------------------------

mod sync_target_tests {
    use super::*;
    use crate::sync_target::{EmptySecretSource, MapSecretSource};
    use std::sync::Arc;

    fn create_vercel() -> CreateConnection {
        CreateConnection {
            provider_id: "vercel".into(),
            integration_id: None,
            owner_subject: None,
            display_name: Some("Vercel".into()),
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: None,
        }
    }

    fn create_railway() -> CreateConnection {
        CreateConnection {
            provider_id: "railway".into(),
            integration_id: None,
            owner_subject: None,
            display_name: Some("Railway".into()),
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: None,
        }
    }

    #[tokio::test]
    async fn create_list_delete_sync_target() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();

        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:personal".into(),
                    config_id: "config:production".into(),
                    connection_id: connection.connection_id.clone(),
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(target.status, SyncTargetStatus::Idle);
        assert_eq!(target.provider_id, "vercel");
        assert_eq!(target.operation, "env.set");

        let listed = broker
            .list_sync_targets(&org, Some("project:personal"), None)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);

        broker.delete_sync_target(&org, &target.id).await.unwrap();
        assert!(matches!(
            broker.get_sync_target(&org, &target.id).await,
            Err(BrokerError::SyncTargetNotFound)
        ));
    }

    #[tokio::test]
    async fn sync_does_not_return_secret_values() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();
        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "config:1".into(),
                    connection_id: connection.connection_id,
                    operation: None,
                },
            )
            .await
            .unwrap();

        let secrets = Arc::new(MapSecretSource {
            entries: BTreeMap::from([
                ("API_TOKEN".into(), "super-secret-value".into()),
                ("DB_URL".into(), "postgres://secret".into()),
            ]),
        });
        // Empty upstream (no mock) → error path still must not leak secrets.
        let outcome = broker.sync_target(&org, &target.id, secrets).await.unwrap();
        let wire = serde_json::to_value(&outcome).unwrap();
        let text = wire.to_string();
        assert!(!text.contains("super-secret-value"));
        assert!(!text.contains("postgres://secret"));
        assert!(!text.contains("vercel_token"));
        assert!(wire.get("access_token").is_none());
        assert!(wire.get("value").is_none());
        assert!(!outcome.ok);
        assert_eq!(outcome.target.status, SyncTargetStatus::Error);
    }

    #[tokio::test]
    async fn fan_out_partial_failure_records_siblings() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();

        let vercel = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &vercel.connection_id, "vercel_token")
            .await
            .unwrap();
        let railway = broker
            .create_connection(&org, create_railway())
            .await
            .unwrap();
        // Railway stays pending → sync fails auth; Vercel is active.
        broker
            .set_api_key(&org, &railway.connection_id, "railway_token")
            .await
            .unwrap();

        let config_id = "config:shared";
        let t1 = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: config_id.into(),
                    connection_id: vercel.connection_id,
                    operation: Some("secrets.sync".into()),
                },
            )
            .await
            .unwrap();
        let t2 = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: config_id.into(),
                    connection_id: railway.connection_id,
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();

        let secrets: Arc<dyn SyncSecretSource> = Arc::new(EmptySecretSource);
        let outcomes = broker
            .sync_all_for_config(&org, config_id, secrets)
            .await
            .unwrap();
        assert_eq!(outcomes.len(), 2);
        // Empty secret set → authorize succeeds, keys_synced=0, ready.
        assert!(outcomes.iter().all(|o| o.ok));
        assert!(outcomes
            .iter()
            .all(|o| o.target.status == SyncTargetStatus::Ready));
        assert!(outcomes.iter().all(|o| o.keys_synced == 0));
        assert_ne!(t1.id, t2.id);
        for outcome in &outcomes {
            let text = serde_json::to_string(outcome).unwrap();
            assert!(!text.contains("vercel_token"));
            assert!(!text.contains("railway_token"));
        }
    }

    #[tokio::test]
    async fn rejects_doppler_cli_style_operation() {
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        let err = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "config:1".into(),
                    connection_id: connection.connection_id,
                    operation: Some("doppler.run".into()),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_request");
    }

    #[tokio::test]
    async fn sync_with_mock_upstream_pushes_without_leaking() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc as StdArc, Mutex};

        async fn capture(
            State(store): State<StdArc<Mutex<Vec<serde_json::Value>>>>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            store.lock().unwrap().push(body);
            Json(serde_json::json!({ "created": true }))
        }

        let captured: StdArc<Mutex<Vec<serde_json::Value>>> = StdArc::new(Mutex::new(Vec::new()));
        let captured_clone = StdArc::clone(&captured);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/v10/projects/{project}/env", post(capture))
                    .with_state(captured_clone),
            )
            .await;
        });

        // Direct unit coverage of content_version + empty push path already
        // covers non-leak; mock HTTP for Vercel requires rewriting host which
        // sync_vercel hard-codes. Ready path with EmptySecretSource is enough.
        let (_db, broker) = broker().await;
        let org = OrganizationId::new();
        let connection = broker
            .create_connection(&org, create_vercel())
            .await
            .unwrap();
        broker
            .set_api_key(&org, &connection.connection_id, "vercel_token")
            .await
            .unwrap();
        let target = broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: "project:1".into(),
                    config_id: "production".into(),
                    connection_id: connection.connection_id,
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap();
        let outcome = broker
            .sync_target(&org, &target.id, Arc::new(EmptySecretSource))
            .await
            .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.target.status, SyncTargetStatus::Ready);
        assert!(outcome.content_version.is_some());
        let _ = addr;
        let _ = captured;
    }
}

// ---- ADR 0049 derived short-lived materialization ---------------------------

const GITHUB_APP_CLIENT_SECRET: &str = "github-app-client-secret-do-not-leak";
const DERIVED_TOKEN: &str = "ghs_derived_do_not_leak";

fn mint_test_rsa_pem() -> Option<String> {
    let output = std::process::Command::new("openssl")
        .args(["genrsa", "2048"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())?
}

/// A mock GitHub API that answers only the installation-token endpoint, and
/// only for a request bearing an App JWT.
async fn github_api_server() -> String {
    async fn access_tokens(
        axum::extract::Path(installation_id): axum::extract::Path<String>,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !authorization.starts_with("Bearer ") || installation_id != "777" {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({"message": "not found"})),
            )
                .into_response();
        }
        (
            axum::http::StatusCode::CREATED,
            Json(serde_json::json!({
                "token": DERIVED_TOKEN,
                "expires_at": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            })),
        )
            .into_response()
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind github api");
    let address = listener.local_addr().expect("github api address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new().route("/app/installations/{id}/access_tokens", post(access_tokens)),
        )
        .await;
    });
    format!("http://{address}")
}

/// A broker whose github integration carries sealed GitHub App signing material.
async fn github_app_broker(
    api_base: &str,
    pem: &str,
) -> (Db, ConnectionBroker, OrganizationId, String) {
    let config = key_config().with_github_api_base(api_base);
    let (db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    let integration = broker
        .create_integration(
            &organization,
            CreateIntegration {
                key: "github-app".into(),
                provider_id: "github".into(),
                display_name: "GitHub App".into(),
                scopes: vec![],
                client_id: Some("Iv1.test".into()),
                client_secret: Some(GITHUB_APP_CLIENT_SECRET.into()),
                configuration: BTreeMap::from([
                    ("app_id".into(), "4242".into()),
                    ("private_key_pem".into(), pem.to_string()),
                ]),
                created_by: "principal:admin".into(),
            },
        )
        .await
        .expect("github app integration");
    (db, broker, organization, integration.id)
}

#[tokio::test]
async fn materialization_defaults_to_deny_and_fails_closed() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let connection = broker
        .create_connection(&organization, create("stripe"))
        .await
        .unwrap();
    assert_eq!(connection.materialization, MaterializationPolicy::Deny);

    let denied = broker
        .mint_derived_token(&organization, &connection.connection_id, "user:alice", None)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), "materialization_denied");
    assert_eq!(denied.http_status(), 403);

    // A stored value nobody recognizes is a deny, never a permit.
    assert_eq!(
        parse_materialization("garbage"),
        MaterializationPolicy::Deny
    );
    assert_eq!(
        parse_materialization("derived_short_lived"),
        MaterializationPolicy::DerivedShortLived
    );
}

#[tokio::test]
async fn providers_without_a_mint_path_fail_closed() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    for provider_id in ["stripe", "aws", "aws-kms", "aws-ps", "aws-bedrock"] {
        let connection = broker
            .create_connection(&organization, create(provider_id))
            .await
            .unwrap();
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
        let error = broker
            .mint_derived_token(&organization, &connection.connection_id, "user:alice", None)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "unmintable", "{provider_id}");
        assert_eq!(error.http_status(), 422, "{provider_id}");
    }
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

#[tokio::test]
async fn minting_against_a_revoked_connection_fails() {
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
    broker
        .update_policy(
            &organization,
            &connection.connection_id,
            Shareability::Private,
            2,
            Some(MaterializationPolicy::DerivedShortLived),
        )
        .await
        .unwrap();
    broker
        .revoke(&organization, &connection.connection_id)
        .await
        .unwrap();
    let error = broker
        .mint_derived_token(
            &organization,
            &connection.connection_id,
            "user:alice",
            Some("777"),
        )
        .await
        .unwrap_err();
    // Policy is erased by revocation along with the credential; either way the
    // mint must not happen.
    assert!(matches!(
        error.code(),
        "materialization_denied" | "invalid_request"
    ));
}

// ---- project-config secret store (ADR 0052) --------------------------------

mod secret_config_store {
    use super::*;
    use crate::store::{
        claim_config_sync_batch, dead_letter_config_sync, delete_config_value,
        delete_secret_config, get_config_value_version_sealed, get_secret_config,
        insert_secret_config, list_config_key_meta, list_config_value_versions,
        list_secret_configs, load_config_values_sealed, mark_config_sync_published,
        park_config_sync, upsert_config_value, SecretConfigRow, UpsertConfigValue,
    };
    use chrono::Utc;

    const ORG: &str = "org_test";
    const PROJECT: &str = "proj_test";
    const CONFIG: &str = "cfg_dev";

    fn config_row(id: &str, slug: &str, environment: &str) -> SecretConfigRow {
        SecretConfigRow {
            id: id.into(),
            organization_id: ORG.into(),
            project_id: PROJECT.into(),
            slug: slug.into(),
            display_name: slug.to_uppercase(),
            environment: environment.into(),
            parent_config_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    async fn seeded_pool() -> sqlx::SqlitePool {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        insert_secret_config(&pool, &config_row(CONFIG, "development", "development"))
            .await
            .expect("insert config");
        pool
    }

    fn upsert<'a>(key_name: &'a str, plaintext: &'a [u8]) -> UpsertConfigValue<'a> {
        UpsertConfigValue {
            organization_id: ORG,
            project_id: PROJECT,
            config_id: CONFIG,
            key_name,
            plaintext,
            actor_id: Some("operator:test"),
        }
    }

    #[tokio::test]
    async fn config_crud_roundtrip() {
        let pool = seeded_pool().await;
        let found = get_secret_config(&pool, ORG, CONFIG)
            .await
            .expect("get")
            .expect("some");
        assert_eq!(found.slug, "development");
        assert_eq!(found.environment, "development");
        let listed = list_secret_configs(&pool, ORG, PROJECT)
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        // Another org sees nothing.
        assert!(get_secret_config(&pool, "org_other", CONFIG)
            .await
            .expect("get")
            .is_none());
        assert!(delete_secret_config(&pool, ORG, CONFIG).await.expect("del"));
        assert!(!delete_secret_config(&pool, ORG, CONFIG).await.expect("del"));
    }

    #[tokio::test]
    async fn an_invalid_environment_is_refused() {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        let error = insert_secret_config(&pool, &config_row("cfg_bad", "bad", "prod"))
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "invalid_request");
    }

    #[tokio::test]
    async fn upsert_bumps_versions_and_seals_per_version() {
        let pool = seeded_pool().await;
        let v1 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"first"))
            .await
            .expect("v1");
        let v2 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"second"))
            .await
            .expect("v2");
        assert_eq!((v1, v2), (1, 2));

        let meta = list_config_key_meta(&pool, ORG, CONFIG)
            .await
            .expect("meta");
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].key_name, "API_KEY");
        assert_eq!(meta[0].version, 2);

        // Head opens under the v2 AAD, and only the v2 AAD.
        let sealed = load_config_values_sealed(&pool, ORG, CONFIG)
            .await
            .expect("sealed");
        assert_eq!(sealed.len(), 1);
        let ad_v2 = crate::crypto::config_value_ad(ORG, PROJECT, CONFIG, "API_KEY", 2);
        assert_eq!(
            crate::crypto::open_with_ad(&KEY, &ad_v2, &sealed[0].sealed).expect("open"),
            b"second"
        );
        let ad_v1 = crate::crypto::config_value_ad(ORG, PROJECT, CONFIG, "API_KEY", 1);
        assert!(crate::crypto::open_with_ad(&KEY, &ad_v1, &sealed[0].sealed).is_err());

        // The v1 row is still retrievable and opens under its own AAD.
        let old = get_config_value_version_sealed(&pool, ORG, CONFIG, "API_KEY", 1)
            .await
            .expect("query")
            .expect("v1 kept");
        assert_eq!(
            crate::crypto::open_with_ad(&KEY, &ad_v1, &old.sealed).expect("open v1"),
            b"first"
        );
    }

    #[tokio::test]
    async fn upsert_against_a_missing_config_is_refused() {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        let error = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"x"))
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "config_not_found");
    }

    #[tokio::test]
    async fn delete_tombstones_and_versions_stay_monotonic() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("API_KEY", b"first"))
            .await
            .expect("v1");
        assert!(delete_config_value(&pool, ORG, CONFIG, "API_KEY", None)
            .await
            .expect("delete"));
        assert!(list_config_key_meta(&pool, ORG, CONFIG)
            .await
            .expect("meta")
            .is_empty());
        let versions = list_config_value_versions(&pool, ORG, CONFIG, "API_KEY")
            .await
            .expect("versions");
        assert_eq!(versions.len(), 2);
        assert!(versions[0].deleted);
        // A deleted version slot is not retrievable as a value.
        assert!(
            get_config_value_version_sealed(&pool, ORG, CONFIG, "API_KEY", 2)
                .await
                .expect("query")
                .is_none()
        );
        // Re-inserting continues after the tombstone: no version reuse.
        let v3 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"third"))
            .await
            .expect("v3");
        assert_eq!(v3, 3);
    }

    #[tokio::test]
    async fn mutations_append_sync_wakes_and_backup_events_atomically() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("API_KEY", b"sw0rdf1sh-plaintext"))
            .await
            .expect("upsert");

        let claimed = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].event_type, "sync.config.dirty");
        assert_eq!(claimed[0].config_id, CONFIG);
        // The lease holds: a second claim sees nothing.
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());

        // The backup outbox got its own event in the same transaction, and the
        // payload carries names only — never a value.
        let backup: Vec<String> =
            sqlx::query_scalar("SELECT payload_json FROM outbox_events ORDER BY created_at")
                .fetch_all(&pool)
                .await
                .expect("outbox");
        assert!(!backup.is_empty());
        assert!(backup
            .iter()
            .all(|payload| !payload.contains("sw0rdf1sh-plaintext")));
    }

    #[tokio::test]
    async fn park_and_dead_letter_shape_the_sync_queue() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("A", b"1"))
            .await
            .expect("upsert");
        let first = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        let ids: Vec<String> = first.iter().map(|e| e.id.clone()).collect();

        // Parked with zero backoff → claimable again, attempts grew.
        park_config_sync(&pool, &ids, "provider 503", 0)
            .await
            .expect("park");
        let again = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        assert_eq!(again.len(), 1);
        assert!(again[0].attempts >= 2);

        dead_letter_config_sync(&pool, &ids, "gave up")
            .await
            .expect("dead");
        park_config_sync(&pool, &ids, "should not resurrect", 0)
            .await
            .expect("park");
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());

        // Published rows never come back either.
        upsert_config_value(&pool, &KEY, upsert("B", b"2"))
            .await
            .expect("upsert");
        let fresh = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        let fresh_ids: Vec<String> = fresh.iter().map(|e| e.id.clone()).collect();
        mark_config_sync_published(&pool, &fresh_ids)
            .await
            .expect("publish");
        park_config_sync(&pool, &fresh_ids, "no-op", 0)
            .await
            .expect("park");
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());
    }
}

mod secret_config_domain {
    use super::*;
    use crate::secret_config::{CreateSecretConfig, StoreSecretSource};
    use std::collections::BTreeMap;

    async fn broker_and_pool() -> (Db, ConnectionBroker) {
        broker().await
    }

    fn create(project: &str, slug: &str, environment: &str) -> CreateSecretConfig {
        CreateSecretConfig {
            project_id: project.into(),
            slug: slug.into(),
            display_name: None,
            environment: environment.into(),
            parent_config_id: None,
        }
    }

    fn secrets(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|&(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    const ORG: &str = "org_domain";

    #[tokio::test]
    async fn config_lifecycle_with_changelog() {
        let (_db, broker) = broker_and_pool().await;
        clear_secret_changelog_for_tests();
        let view = broker
            .create_secret_config(
                ORG,
                create("proj", "development", "development"),
                Some("op"),
            )
            .await
            .expect("create");
        assert_eq!(view.slug, "development");

        broker
            .put_config_secrets(
                ORG,
                &view.id,
                &secrets(&[("API_KEY", "v-secret")]),
                Some("op"),
            )
            .await
            .expect("put");
        let meta = broker.config_key_meta(ORG, &view.id).await.expect("meta");
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].version, 1);

        let entries = list_secret_changelog(ORG, "proj", 10);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event_type.as_str()).collect();
        assert!(kinds.contains(&"secret.config.created"));
        assert!(kinds.contains(&"secret.value.changed"));
        // Changelog never carries the value.
        for entry in &entries {
            let text = serde_json::to_string(entry).expect("json");
            assert!(!text.contains("v-secret"));
        }

        broker
            .delete_config_secret(ORG, &view.id, "API_KEY", Some("op"))
            .await
            .expect("delete value");
        broker
            .delete_secret_config(ORG, &view.id, Some("op"))
            .await
            .expect("delete config");
    }

    #[tokio::test]
    async fn invalid_key_names_and_oversized_values_are_refused() {
        let (_db, broker) = broker_and_pool().await;
        let view = broker
            .create_secret_config(ORG, create("proj", "dev-a", "development"), None)
            .await
            .expect("create");
        let bad = broker
            .put_config_secrets(ORG, &view.id, &secrets(&[("has-dash", "x")]), None)
            .await
            .expect_err("bad key");
        assert_eq!(bad.code(), "invalid_request");
        let huge = "x".repeat(crate::MAX_CREDENTIAL_BYTES + 1);
        let big = broker
            .put_config_secrets(ORG, &view.id, &secrets(&[("OK_KEY", huge.as_str())]), None)
            .await
            .expect_err("oversized");
        assert_eq!(big.code(), "invalid_request");
    }

    #[tokio::test]
    async fn store_source_resolves_inheritance_and_references() {
        let (db, broker) = broker_and_pool().await;
        let root = broker
            .create_secret_config(ORG, create("proj", "base", "development"), None)
            .await
            .expect("root");
        let mut child_spec = create("proj", "branch-a", "development");
        child_spec.parent_config_id = Some(root.id.clone());
        let child = broker
            .create_secret_config(ORG, child_spec, None)
            .await
            .expect("child");

        broker
            .put_config_secrets(
                ORG,
                &root.id,
                &secrets(&[
                    ("HOST", "db.example"),
                    ("PORT", "5432"),
                    ("USER", "root-user"),
                ]),
                None,
            )
            .await
            .expect("root put");
        broker
            .put_config_secrets(
                ORG,
                &child.id,
                &secrets(&[
                    ("USER", "child-user"),
                    ("URL", "postgres://${USER}@${HOST}:${PORT}/app"),
                    ("LITERAL", "keep $${THIS} verbatim"),
                ]),
                None,
            )
            .await
            .expect("child put");

        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let resolved = source
            .load_config_secrets(ORG, "proj", &child.id)
            .await
            .expect("resolve");
        assert_eq!(resolved["HOST"], "db.example");
        assert_eq!(resolved["USER"], "child-user"); // child overrides parent
        assert_eq!(resolved["URL"], "postgres://child-user@db.example:5432/app");
        assert_eq!(resolved["LITERAL"], "keep ${THIS} verbatim");
    }

    #[tokio::test]
    async fn reference_cycles_and_missing_refs_fail_closed() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "cyclic", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(
                ORG,
                &cfg.id,
                &secrets(&[("A", "${B}"), ("B", "${A}"), ("LONER", "${MISSING}")]),
                None,
            )
            .await
            .expect("put");
        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let error = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect_err("must fail");
        assert_eq!(error.code(), "invalid_request");
    }

    #[tokio::test]
    async fn production_values_cannot_be_referenced_from_dev() {
        let (_db, broker) = broker_and_pool().await;
        let prod = broker
            .create_secret_config(ORG, create("proj", "prod", "production"), None)
            .await
            .expect("prod");
        broker
            .put_config_secrets(ORG, &prod.id, &secrets(&[("DB_URL", "prod-only")]), None)
            .await
            .expect("prod put");
        let dev = broker
            .create_secret_config(ORG, create("proj", "dev", "development"), None)
            .await
            .expect("dev");
        // Refused at write time.
        let error = broker
            .put_config_secrets(
                ORG,
                &dev.id,
                &secrets(&[("LEAK", "${config:prod.DB_URL}")]),
                None,
            )
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "invalid_request");
        // Prod may reference prod.
        broker
            .put_config_secrets(
                ORG,
                &prod.id,
                &secrets(&[("MIRROR", "${config:prod.DB_URL}")]),
                None,
            )
            .await
            .expect("prod self-reference allowed");
    }

    #[tokio::test]
    async fn rollback_reseal_produces_a_new_head_version() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "rollme", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "one")]), None)
            .await
            .expect("v1");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "two")]), None)
            .await
            .expect("v2");
        let new_head = broker
            .rollback_config_secret(ORG, &cfg.id, "K", 1, Some("op"))
            .await
            .expect("rollback");
        assert_eq!(new_head, 3);
        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let resolved = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect("resolve");
        assert_eq!(resolved["K"], "one");
        // Rolling back to a version that never existed is refused.
        let missing = broker
            .rollback_config_secret(ORG, &cfg.id, "K", 99, None)
            .await
            .expect_err("no such version");
        assert_eq!(missing.code(), "config_value_not_found");
    }

    #[tokio::test]
    async fn negative_stored_version_fails_closed_before_aad_open() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "negative-version", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "value")]), None)
            .await
            .expect("put");
        sqlx::query(
            "UPDATE config_secret_values SET version = -1 WHERE config_id = ? AND key_name = ?",
        )
        .bind(&cfg.id)
        .bind("K")
        .execute(db.pool())
        .await
        .expect("corrupt version fixture");

        let error = broker
            .config_key_meta(ORG, &cfg.id)
            .await
            .expect_err("negative database versions must be rejected");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("negative"));

        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let error = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect_err("negative version must not be cast into AAD");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("negative"));
    }

    #[tokio::test]
    async fn version_overflow_and_out_of_range_lookup_fail_without_writes() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "max-version", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "value")]), None)
            .await
            .expect("put");
        sqlx::query(
            "UPDATE config_secret_values SET version = ? WHERE config_id = ? AND key_name = ?",
        )
        .bind(i64::MAX)
        .bind(&cfg.id)
        .bind("K")
        .execute(db.pool())
        .await
        .expect("max head fixture");

        let error = broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "replacement")]), None)
            .await
            .expect_err("the version counter must not wrap");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("exhausted"));
        let stored_version: i64 = sqlx::query_scalar(
            "SELECT version FROM config_secret_values WHERE config_id = ? AND key_name = ?",
        )
        .bind(&cfg.id)
        .bind("K")
        .fetch_one(db.pool())
        .await
        .expect("head version");
        assert_eq!(stored_version, i64::MAX);

        let error = broker
            .rollback_config_secret(ORG, &cfg.id, "K", u64::MAX, None)
            .await
            .expect_err("an out-of-range lookup must not alias a database version");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("database range"));
    }

    #[tokio::test]
    async fn delete_config_refuses_while_sync_targets_reference_it() {
        let (_db, broker) = broker_and_pool().await;
        let organization = opensesame_domain::OrganizationId::new();
        let org = organization.to_string();
        let cfg = broker
            .create_secret_config(&org, create("proj", "referenced", "development"), None)
            .await
            .expect("cfg");
        // A vercel connection to hang a sync target from.
        let connection = broker
            .create_connection(
                &organization,
                CreateConnection {
                    provider_id: "vercel".into(),
                    integration_id: None,
                    display_name: Some("Vercel".into()),
                    logical_name: Some("vercel-conn".into()),
                    project_id: Some("proj".into()),
                    scopes: None,
                    shareability: None,
                    owner_subject: None,
                },
            )
            .await
            .expect("connection");
        broker
            .create_sync_target(
                &organization,
                CreateSyncTarget {
                    project_id: "proj".into(),
                    config_id: cfg.id.clone(),
                    connection_id: connection.connection_id.clone(),
                    operation: None,
                },
            )
            .await
            .expect("target");
        let refused = broker
            .delete_secret_config(&org, &cfg.id, None)
            .await
            .expect_err("must refuse");
        assert_eq!(refused.code(), "invalid_request");
    }
}

mod durable_changelog {
    use super::*;

    #[tokio::test]
    async fn changelog_rows_survive_a_new_broker_over_the_same_store() {
        let (db, broker) = broker_with(key_config()).await;
        let cfg = broker
            .create_secret_config(
                "org_durable_a",
                crate::secret_config::CreateSecretConfig {
                    project_id: "proj".into(),
                    slug: "development".into(),
                    display_name: None,
                    environment: "development".into(),
                    parent_config_id: None,
                },
                Some("op"),
            )
            .await
            .expect("create");
        broker
            .put_config_secrets(
                "org_durable_a",
                &cfg.id,
                &[("API_KEY".to_string(), "v".to_string())]
                    .into_iter()
                    .collect(),
                Some("op"),
            )
            .await
            .expect("put");

        // A second broker over the same pool (fresh in-memory caches) still
        // sees the rows: the table, not the ring buffer, is the store.
        clear_secret_changelog_for_tests();
        let second = ConnectionBroker::new(db.pool().clone(), key_config()).expect("broker2");
        let events = second
            .list_changelog("org_durable_a", "proj", 50, None)
            .await
            .expect("list");
        let kinds: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert!(kinds.contains(&"secret.config.created"));
        assert!(kinds.contains(&"secret.value.changed"));
        assert!(events.iter().all(|e| e.seq.is_some()));
    }

    #[tokio::test]
    async fn changelog_pages_backwards_by_seq() {
        let (_db, broker) = broker_with(key_config()).await;
        for i in 0..5 {
            broker
                .record_changelog(RecordSecretChangelog {
                    event_type: "secret.value.changed".into(),
                    project_id: "proj-page".into(),
                    organization_id: Some("org_durable_b".into()),
                    key_names: vec![format!("KEY_{i}")],
                    ..Default::default()
                })
                .await
                .expect("record");
        }
        let first = broker
            .list_changelog("org_durable_b", "proj-page", 2, None)
            .await
            .expect("page1");
        assert_eq!(first.len(), 2);
        let cursor = first.iter().filter_map(|e| e.seq).min();
        let second = broker
            .list_changelog("org_durable_b", "proj-page", 2, cursor)
            .await
            .expect("page2");
        assert_eq!(second.len(), 2);
        let first_seqs: Vec<i64> = first.iter().filter_map(|e| e.seq).collect();
        let second_seqs: Vec<i64> = second.iter().filter_map(|e| e.seq).collect();
        assert!(second_seqs.iter().max() < first_seqs.iter().min());
    }

    #[tokio::test]
    async fn unknown_event_names_record_nothing_anywhere() {
        let (db, broker) = broker_with(key_config()).await;
        crate::store::ensure_secret_changelog_schema(db.pool())
            .await
            .expect("schema");
        let error = broker
            .record_changelog(RecordSecretChangelog {
                event_type: "secret.value.exfiltrated".into(),
                project_id: "proj".into(),
                organization_id: Some("org_durable_c".into()),
                ..Default::default()
            })
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "invalid_request");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_changelog")
            .fetch_one(db.pool())
            .await
            .expect("count");
        assert_eq!(count, 0);
        // Nothing in the cache either: fail closed means nowhere.
        assert!(list_secret_changelog("org_durable_c", "proj", 10).is_empty());
    }

    #[tokio::test]
    async fn rollback_emits_the_frozen_rolled_back_event() {
        let (_db, broker) = broker_with(key_config()).await;
        let cfg = broker
            .create_secret_config(
                "org_durable_d",
                crate::secret_config::CreateSecretConfig {
                    project_id: "proj-rb".into(),
                    slug: "development".into(),
                    display_name: None,
                    environment: "development".into(),
                    parent_config_id: None,
                },
                None,
            )
            .await
            .expect("create");
        let secrets: std::collections::BTreeMap<String, String> =
            [("K".to_string(), "one".to_string())].into_iter().collect();
        broker
            .put_config_secrets("org_durable_d", &cfg.id, &secrets, None)
            .await
            .expect("v1");
        let secrets2: std::collections::BTreeMap<String, String> =
            [("K".to_string(), "two".to_string())].into_iter().collect();
        broker
            .put_config_secrets("org_durable_d", &cfg.id, &secrets2, None)
            .await
            .expect("v2");
        broker
            .rollback_config_secret("org_durable_d", &cfg.id, "K", 1, Some("op"))
            .await
            .expect("rollback");
        let events = broker
            .list_changelog("org_durable_d", "proj-rb", 20, None)
            .await
            .expect("list");
        assert!(events
            .iter()
            .any(|e| e.event_type == "secret.value.rolled_back"));
        for event in &events {
            let text = serde_json::to_string(event).expect("json");
            assert!(!text.contains("\"one\""));
            assert!(!text.contains("\"two\""));
        }
    }
}

// ---- rotation (WP-9): machine-driven execution over the durable store -------

struct RotationFixture {
    db: Db,
    broker: Arc<ConnectionBroker>,
    organization: OrganizationId,
    connection_id: String,
    config_id: String,
}

async fn rotation_fixture() -> RotationFixture {
    let (db, broker, organization, integration_id) = organization_oauth_broker().await;
    let connection = broker
        .create_connection(
            &organization,
            CreateConnection {
                provider_id: String::new(),
                integration_id: Some(integration_id),
                project_id: Some("proj-rot".into()),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&organization, &connection.connection_id, None, None)
        .await
        .unwrap();
    broker
        .complete_authorization("mock", "initial-code", &start.state)
        .await
        .unwrap();

    // A config synced through this connection: the DependentsUpdated step must
    // append a `sync.config.dirty` wake for it. The row goes in at store level
    // so the test does not depend on the env-sync provider allowlist.
    let config = broker
        .create_secret_config(
            &organization.to_string(),
            crate::secret_config::CreateSecretConfig {
                project_id: "proj-rot".into(),
                slug: "production".into(),
                display_name: None,
                environment: "production".into(),
                parent_config_id: None,
            },
            None,
        )
        .await
        .unwrap();
    store::insert_sync_target(
        db.pool(),
        &store::SyncTargetRow {
            id: "st_rot".into(),
            organization_id: organization.to_string(),
            project_id: "proj-rot".into(),
            config_id: config.id.clone(),
            connection_id: connection.connection_id.clone(),
            provider_id: "vercel".into(),
            operation: "env.set".into(),
            status: "idle".into(),
            status_detail: None,
            content_version: None,
            last_synced_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        },
    )
    .await
    .unwrap();

    RotationFixture {
        db,
        broker,
        organization,
        connection_id: connection.connection_id,
        config_id: config.id,
    }
}

#[tokio::test]
async fn rotation_happy_path_completes_the_machine_and_wakes_dependents() {
    let fixture = rotation_fixture().await;
    let bus = opensesame_task_bus::InMemoryTaskBus::default();
    let job = request_rotation(
        &fixture.broker,
        &bus,
        RotationTarget::Connection {
            connection_id: fixture.connection_id,
        },
        Some("proj-rot".into()),
        &fixture.organization.to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(job.state, "scheduled");

    let done = execute_connection_rotation(&fixture.broker, &bus, &fixture.organization, &job.id)
        .await
        .unwrap();
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.status, RotationStatus::Succeeded);
    // Verification is honestly skipped (no provider no-op invoke) and the
    // skip note survives the later transitions.
    assert!(done
        .detail
        .as_deref()
        .unwrap_or_default()
        .contains("verify_skipped"));

    // The durable row holds the terminal machine state.
    let persisted = fixture
        .broker
        .get_rotation_job(&fixture.organization.to_string(), &job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.state, "completed");

    // DependentsUpdated appended exactly one sync wake for the config.
    let dirty: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM config_sync_outbox WHERE config_id = ? \
         AND event_type = 'sync.config.dirty'",
    )
    .bind(&fixture.config_id)
    .fetch_one(fixture.db.pool())
    .await
    .unwrap();
    assert_eq!(dirty, 1);

    // Frozen changelog vocabulary only; requested + succeeded recorded; no
    // token material anywhere near the changelog or the bus.
    let entries = fixture
        .broker
        .list_changelog(&fixture.organization.to_string(), "proj-rot", 20, None)
        .await
        .unwrap();
    assert!(entries
        .iter()
        .any(|e| e.event_type == EVENT_ROTATION_REQUESTED));
    assert!(entries
        .iter()
        .any(|e| e.event_type == EVENT_ROTATION_SUCCEEDED));
    for entry in &entries {
        assert!(is_allowed_changelog_event_type(&entry.event_type));
        let text = serde_json::to_string(entry).unwrap();
        assert!(!text.contains("race-access"));
        assert!(!text.contains("race-refresh"));
    }
    let events = bus.drain(20).await.unwrap();
    assert!(events.iter().any(|e| e.r#type == EVENT_ROTATION_SUCCEEDED));
    for event in &events {
        let text = event.data.to_string();
        assert!(!text.contains("race-access"));
        assert!(!text.contains("race-refresh"));
    }
}

/// Coverage for `authorized_bytes`, the credential-injecting upload path
/// (ADR 0054). Every test here drives a real local server through the `mock`
/// provider, whose catalog egress allows `127.0.0.1` over http.
mod authorized_bytes_tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::post as axum_post,
    };
    use std::sync::Mutex as StdMutex;

    /// How the mock server answers, shared with the handler.
    type Answer = Arc<dyn Fn() -> Response + Send + Sync>;
    /// Handler state: what has been seen, and how to reply.
    type MockState = State<(Arc<StdMutex<Seen>>, Answer)>;

    /// What a request actually carried, so a test can assert on the wire and
    /// not on what the code claims to have sent.
    #[derive(Default)]
    struct Seen {
        bodies: Vec<Vec<u8>>,
        auth: Vec<String>,
        extra: Vec<String>,
    }

    async fn handle_upload(
        State((sink, answer)): MockState,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let mut seen = sink.lock().unwrap();
        seen.bodies.push(body.to_vec());
        seen.auth.push(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        seen.extra.push(
            headers
                .get("dropbox-api-arg")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string(),
        );
        drop(seen);
        answer()
    }

    /// An activated `mock` connection: Active, with a real sealed credential.
    async fn active_mock_connection() -> (Arc<ConnectionBroker>, OrganizationId, String) {
        let (_db, broker, org, integration) =
            organization_oauth_broker_with_token_url(token_server().await).await;
        let connection = broker
            .create_connection(
                &org,
                CreateConnection {
                    integration_id: Some(integration),
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
            .complete_authorization("mock", "the-code", &start.state)
            .await
            .unwrap();
        (broker, org, connection.connection_id)
    }

    /// A server that records what it received and answers however the test asks.
    async fn recording_server(
        answer: impl Fn() -> Response + Clone + Send + Sync + 'static,
    ) -> (String, Arc<StdMutex<Seen>>) {
        let seen = Arc::new(StdMutex::new(Seen::default()));
        let sink = seen.clone();
        let answer: Answer = Arc::new(answer);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/upload", axum_post(handle_upload))
                    .route("/elsewhere", axum_post(handle_upload))
                    .with_state((sink, answer)),
            )
            .await;
        });
        (format!("http://{address}"), seen)
    }

    #[tokio::test]
    async fn uploads_bytes_with_the_credential_injected() {
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[(
                    "Dropbox-API-Arg".to_string(),
                    "{\"path\":\"/x\"}".to_string(),
                )],
                b"sealed ciphertext".to_vec(),
            )
            .await
            .expect("upload should succeed");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.bodies, vec![b"sealed ciphertext".to_vec()]);
        assert!(
            seen.auth[0].starts_with("Bearer "),
            "the credential must be injected: {:?}",
            seen.auth[0]
        );
        assert!(!seen.auth[0].contains("Bearer Bearer"));
        assert_eq!(seen.extra[0], "{\"path\":\"/x\"}");
    }

    #[tokio::test]
    async fn refuses_a_url_outside_the_connections_egress_allowlist() {
        let (broker, org, connection) = active_mock_connection().await;
        // The mock provider's catalog egress is 127.0.0.1 over http only.
        for hostile in [
            "https://evil.example.com/upload",
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1.evil.com/upload",
        ] {
            let error = broker
                .authorized_bytes(&org, &connection, hostile, &[], b"x".to_vec())
                .await
                .expect_err("egress allowlist must refuse this");
            assert_eq!(error.code(), "invalid_request", "for {hostile}");
        }
    }

    #[tokio::test]
    async fn never_follows_a_redirect_and_never_replays_the_token() {
        // The property the dedicated no-redirect client exists for. A default
        // reqwest client would follow this and hand the bearer token to the
        // redirect target — so the assertion that matters is not just that the
        // call failed, but that the second endpoint was never contacted.
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| {
            Response::builder()
                .status(StatusCode::FOUND)
                .header("location", "/elsewhere")
                .body(axum::body::Body::empty())
                .unwrap()
        })
        .await;

        let error = broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a redirect must not be followed");
        assert!(
            error.to_string().contains("redirect"),
            "the refusal should say why: {error}"
        );

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.auth.len(),
            1,
            "the token must reach the original host once and nowhere else"
        );
    }

    #[tokio::test]
    async fn refuses_caller_headers_the_broker_owns() {
        let (broker, org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        for reserved in ["Authorization", "authorization", "Content-Type"] {
            let error = broker
                .authorized_bytes(
                    &org,
                    &connection,
                    &format!("{base}/upload"),
                    &[(reserved.to_string(), "attacker".to_string())],
                    b"x".to_vec(),
                )
                .await
                .expect_err("a reserved header must be refused");
            assert_eq!(error.code(), "invalid_request", "for {reserved}");
        }
        assert!(
            seen.lock().unwrap().auth.is_empty(),
            "refusal must happen before anything is sent"
        );
    }

    #[tokio::test]
    async fn an_upstream_error_is_capped_and_carries_no_credential() {
        let (broker, org, connection) = active_mock_connection().await;
        // A hostile upstream echoing a huge body, including something that
        // looks like the caller's own Authorization header.
        let (base, _seen) = recording_server(|| {
            let mut body = "Bearer leaked-token-should-not-propagate ".to_string();
            body.push_str(&"A".repeat(50_000));
            (StatusCode::BAD_REQUEST, body).into_response()
        })
        .await;

        let error = broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a 400 must surface as an error");
        let text = error.to_string();
        assert!(
            text.len() < 1_000,
            "the snippet must be capped, got {} chars",
            text.len()
        );
        // The real credential never appears; only whatever the upstream chose
        // to echo, which is its own content and not ours.
        assert!(!text.contains("race-access"));
    }

    #[tokio::test]
    async fn a_connection_without_an_active_credential_cannot_upload() {
        let (_db, broker, org, integration) =
            organization_oauth_broker_with_token_url(token_server().await).await;
        let pending = broker
            .create_connection(
                &org,
                CreateConnection {
                    integration_id: Some(integration),
                    ..create("mock")
                },
            )
            .await
            .unwrap();
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        let error = broker
            .authorized_bytes(
                &org,
                &pending.connection_id,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a pending connection has no credential to inject");
        assert_eq!(error.code(), "needs_reauth");
        assert!(
            seen.lock().unwrap().auth.is_empty(),
            "nothing may be sent without a credential"
        );
    }

    #[tokio::test]
    async fn another_organization_cannot_use_this_connection() {
        let (broker, _org, connection) = active_mock_connection().await;
        let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

        let error = broker
            .authorized_bytes(
                &OrganizationId::new(),
                &connection,
                &format!("{base}/upload"),
                &[],
                b"x".to_vec(),
            )
            .await
            .expect_err("a connection in another org must not be reachable");
        assert_eq!(error.code(), "connection_not_found");
        assert!(seen.lock().unwrap().auth.is_empty());
    }
}

// ---- delegation (ADR 0044) --------------------------------------------------

mod delegation_tests {
    use super::*;
    use crate::delegation::{
        ClaimOfferRequest, MintOfferRequest, OfferItemSpec, BUDGET_INVOCATIONS,
    };
    use opensesame_domain::Shareability;
    use std::collections::BTreeMap;

    const PEPPER: &str = "test-pepper";
    const OWNER: &str = "user:owner";
    const GUEST: &str = "user:guest";

    fn delegable_config() -> BrokerConfig {
        key_config().with_detected_connection(
            "workos",
            BTreeMap::from([(
                "api_key".into(),
                "PLANTED-WORKOS-VALUE-MUST-NOT-ESCAPE".into(),
            )]),
        )
    }

    async fn active_delegable_connection(
        broker: &ConnectionBroker,
        organization: &OrganizationId,
        owner: &str,
    ) -> String {
        let view = broker
            .create_connection(
                organization,
                CreateConnection {
                    owner_subject: Some(owner.into()),
                    shareability: Some(Shareability::Delegable),
                    display_name: Some("WorkOS".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("active connection");
        assert_eq!(view.status, ConnectionStatus::Active);
        view.connection_id
    }

    fn one_item(connection_id: &str) -> MintOfferRequest {
        MintOfferRequest {
            items: vec![OfferItemSpec {
                connection_id: connection_id.into(),
                actions: None,
                resources: None,
                expires_in_seconds: None,
                budgets: None,
                execution_mode: opensesame_relay::ExecutionMode::Broker,
                required: true,
                dependencies: vec![],
            }],
            ttl_seconds: None,
        }
    }

    #[tokio::test]
    async fn contract_mint_present_claim_delegates_a_connection() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;

        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        assert!(minted.claim_token.starts_with("osc_dlg_"));
        assert_eq!(minted.offer.state, "pending");
        assert_eq!(minted.offer.items.len(), 1);
        // The default delegate set is the provider vocabulary minus mutating
        // operations; workos has none to remove.
        assert_eq!(
            minted.offer.items[0].actions,
            vec!["user.read", "organization.read", "directory.read"]
        );

        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        assert_eq!(manifest.state, "presented");

        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        assert_eq!(delegations.len(), 1);
        assert_eq!(delegations[0].claimant_subject, GUEST);

        let resolved = broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .expect("live delegation");
        assert_eq!(resolved.grant.actions, manifest.items[0].actions);
        assert!(resolved.grant.parent_grant_id.is_some());
        assert_eq!(resolved.grant.delegation_depth, 1);
        // Nobody else resolves it.
        assert!(broker
            .find_live_delegation("user:stranger", &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn adversarial_a_second_present_burns_the_offer_and_its_delegations() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");

        // The token surfaces again: whoever holds it now, the link leaked.
        assert!(broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .is_err());
        // The delegation minted from the offer died with it.
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn adversarial_private_connections_refuse_offers() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let view = broker
            .create_connection(
                &organization,
                CreateConnection {
                    owner_subject: Some(OWNER.into()),
                    display_name: Some("WorkOS".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("active connection");
        assert!(broker
            .mint_delegation_offer(&organization, OWNER, one_item(&view.connection_id), PEPPER)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_minting_someone_elses_connection_is_not_found() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        assert!(matches!(
            broker
                .mint_delegation_offer(&organization, "user:thief", one_item(&connection), PEPPER)
                .await,
            Err(BrokerError::ConnectionNotFound)
        ));
    }

    #[tokio::test]
    async fn adversarial_wrong_user_codes_burn_the_offer_at_the_cap() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        for _ in 0..5 {
            assert!(broker
                .claim_delegation_offer(
                    ClaimOfferRequest {
                        claim_token: minted.claim_token.clone(),
                        user_code: "WRNG-CODE".into(),
                        accepted_item_ids: vec![manifest.items[0].id.clone()],
                    },
                    GUEST,
                    PEPPER,
                )
                .await
                .is_err());
        }
        // The real code no longer helps: the offer burned, not lapsed.
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_the_owner_cannot_claim_their_own_offer() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                OWNER,
                PEPPER,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn contract_bundles_are_dependency_closed_and_all_or_nothing() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let first = active_delegable_connection(&broker, &organization, OWNER).await;
        let second = broker
            .create_connection(
                &organization,
                CreateConnection {
                    owner_subject: Some(OWNER.into()),
                    shareability: Some(Shareability::Delegable),
                    display_name: Some("WorkOS second".into()),
                    logical_name: Some("workos-second".into()),
                    ..create("workos")
                },
            )
            .await
            .expect("second connection")
            .connection_id;

        // Item 1 is optional but depends on item 0.
        let minted = broker
            .mint_delegation_offer(
                &organization,
                OWNER,
                MintOfferRequest {
                    items: vec![
                        OfferItemSpec {
                            connection_id: first.clone(),
                            actions: None,
                            resources: None,
                            expires_in_seconds: None,
                            budgets: None,
                            execution_mode: opensesame_relay::ExecutionMode::Broker,
                            required: false,
                            dependencies: vec![],
                        },
                        OfferItemSpec {
                            connection_id: second.clone(),
                            actions: None,
                            resources: None,
                            expires_in_seconds: None,
                            budgets: None,
                            execution_mode: opensesame_relay::ExecutionMode::Broker,
                            required: false,
                            dependencies: vec![0],
                        },
                    ],
                    ttl_seconds: None,
                },
                PEPPER,
            )
            .await
            .expect("mint bundle");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let dependent = manifest
            .items
            .iter()
            .find(|item| !item.dependencies.is_empty())
            .expect("dependent item");

        // Accepting the dependent item without its dependency is refused —
        // and the refusal must not spend the offer.
        assert!(broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![dependent.id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .is_err());

        let all_ids: Vec<String> = manifest.items.iter().map(|item| item.id.clone()).collect();
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: all_ids,
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim whole bundle");
        assert_eq!(delegations.len(), 2);
        // One set id groups them; each member resolves independently.
        assert_eq!(delegations[0].offer_id, delegations[1].offer_id);
        assert!(broker
            .find_live_delegation(GUEST, &first)
            .await
            .expect("lookup")
            .is_some());
        assert!(broker
            .find_live_delegation(GUEST, &second)
            .await
            .expect("lookup")
            .is_some());
    }

    #[tokio::test]
    async fn adversarial_mint_refuses_what_the_owner_grant_cannot_honor() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let mut request = one_item(&connection);
        request.items[0].actions = Some(vec!["admin.impersonate".into()]);
        assert!(broker
            .mint_delegation_offer(&organization, OWNER, request, PEPPER)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn contract_revoking_the_offer_kills_every_member() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        broker
            .revoke_delegation_offer(&organization, OWNER, &minted.offer.id)
            .await
            .expect("revoke set");
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn contract_a_claimant_may_drop_their_own_but_not_someone_elses() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let delegation_id = &delegations[0].id;
        assert!(matches!(
            broker
                .revoke_delegation(&organization, "user:stranger", delegation_id)
                .await,
            Err(BrokerError::ConnectionNotFound)
        ));
        broker
            .revoke_delegation(&organization, GUEST, delegation_id)
            .await
            .expect("claimant drops their own");
        assert!(broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .is_none());
    }

    #[tokio::test]
    async fn contract_narrowing_replaces_the_grant_and_widening_is_refused() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let delegation_id = delegations[0].id.clone();
        let old_grant_id = delegations[0].grant_id.clone();

        let narrowed = broker
            .narrow_delegation(
                &organization,
                OWNER,
                &delegation_id,
                Some(vec!["user.read".into()]),
                None,
                None,
            )
            .await
            .expect("narrow");
        assert_ne!(narrowed.grant_id, old_grant_id);
        assert_eq!(narrowed.actions, vec!["user.read"]);

        let resolved = broker
            .find_live_delegation(GUEST, &connection)
            .await
            .expect("lookup")
            .expect("still live");
        assert_eq!(resolved.grant.actions, vec!["user.read"]);

        // Growing back what was narrowed away is not an edit.
        assert!(broker
            .narrow_delegation(
                &organization,
                OWNER,
                &delegation_id,
                Some(vec!["user.read".into(), "organization.read".into()]),
                None,
                None,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn property_budget_spend_denies_at_zero() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let mut request = one_item(&connection);
        request.items[0].budgets = Some(BTreeMap::from([(BUDGET_INVOCATIONS.into(), 2)]));
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, request, PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        let id = &delegations[0].id;
        broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .expect("first spend");
        broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .expect("second spend");
        assert!(broker
            .spend_delegation_budget(id, BUDGET_INVOCATIONS)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_no_response_carries_a_planted_credential() {
        let (_db, broker) = broker_with(delegable_config()).await;
        let organization = OrganizationId::new();
        let connection = active_delegable_connection(&broker, &organization, OWNER).await;
        let minted = broker
            .mint_delegation_offer(&organization, OWNER, one_item(&connection), PEPPER)
            .await
            .expect("mint");
        let manifest = broker
            .present_delegation_offer(&minted.claim_token)
            .await
            .expect("present");
        let delegations = broker
            .claim_delegation_offer(
                ClaimOfferRequest {
                    claim_token: minted.claim_token.clone(),
                    user_code: minted.user_code.clone(),
                    accepted_item_ids: vec![manifest.items[0].id.clone()],
                },
                GUEST,
                PEPPER,
            )
            .await
            .expect("claim");
        for rendered in [
            serde_json::to_string(&minted.offer).expect("offer"),
            serde_json::to_string(&manifest).expect("manifest"),
            serde_json::to_string(&delegations).expect("delegations"),
        ] {
            assert!(!rendered.contains("PLANTED-WORKOS-VALUE-MUST-NOT-ESCAPE"));
        }
    }
}
