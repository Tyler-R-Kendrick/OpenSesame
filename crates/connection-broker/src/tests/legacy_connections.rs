//! Connections written before integrations existed, and unknown providers.

use super::*;

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
