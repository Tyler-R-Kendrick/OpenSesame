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

// Split out of a single 5,027-line `tests.rs`. The fixtures and constants
// below are shared, so they stay here and each module reaches them with
// `use super::*`. Module names deliberately avoid the crate's own module
// names (catalog, rotation, github_app, ...), which that glob also imports.
mod catalog_egress;
mod connection_lifecycle;
mod credential_minting;
mod detected_import;
mod github_app_minting;
mod legacy_connections;
mod org_integrations;
mod revocation_cleanup;
mod web_rotation;

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
