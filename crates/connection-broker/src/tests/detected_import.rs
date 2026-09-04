//! Importing credentials that connection-detect found on the host.

use super::*;

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
