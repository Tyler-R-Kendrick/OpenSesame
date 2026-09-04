//! The connector catalog and credentialed egress through it.

use super::*;

#[test]
fn every_network_catalog_connector_has_a_generic_execution_contract() {
    for provider in catalog::all().expect("catalog") {
        if matches!(&provider.auth, catalog::AuthMethod::Configuration) {
            continue;
        }
        assert_ne!(
            provider.egress.scheme, "none",
            "{} has no egress",
            provider.id
        );
        assert!(
            !provider.operations.is_empty(),
            "{} has no executable operations",
            provider.id
        );
    }
}

#[tokio::test]
async fn catalog_connection_executes_real_credentialed_egress() {
    async fn token(Form(_form): Form<HashMap<String, String>>) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "access_token": "network-token-do-not-return",
            "token_type": "Bearer"
        }))
    }

    async fn fixture(headers: axum::http::HeaderMap) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "authorized": headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                == Some("Bearer network-token-do-not-return")
        }))
    }

    async fn leak(headers: axum::http::HeaderMap) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "echo": headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
        }))
    }

    // Port 0, not a fixed one: the mock provider used to bind 9090, which is
    // also `mock-upstream-idp`'s port, so this test failed against a running
    // dev stack and against any second `cargo test` on the same machine.
    // `token_server_with_expiry` above already does it this way.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind bundled mock provider");
    let provider = listener.local_addr().expect("mock provider address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/token", post(token))
                .route("/fixture", axum::routing::get(fixture))
                .route("/leak", axum::routing::get(leak)),
        )
        .await;
    });

    let config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            token_url: Some(format!("http://{provider}/token")),
            ..Default::default()
        },
    );
    let (_db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    let connection = broker
        .create_connection(&organization, create("mock"))
        .await
        .expect("create connection");
    let start = broker
        .start_authorization(&organization, &connection.connection_id, None, None)
        .await
        .expect("start authorization");
    broker
        .complete_authorization("mock", "code", &start.state)
        .await
        .expect("complete authorization");

    let response = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/fixture"),
            None,
        )
        .await
        .expect("invoke provider");
    assert_eq!(response, serde_json::json!({"authorized": true}));
    assert!(!response.to_string().contains("network-token"));

    let leak = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/leak"),
            None,
        )
        .await
        .expect_err("credential-echoing upstream must fail closed");
    assert!(!leak.to_string().contains("network-token"));
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
