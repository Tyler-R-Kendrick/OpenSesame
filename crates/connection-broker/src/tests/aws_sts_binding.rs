//! STS bindings (ADR 0217): sealed whole, bound to their connection, refused
//! outside the aws family.

use super::*;
use crate::aws_sts::binding::AwsStsBindingInput;

pub(super) const AKID: &str = "AKIAVTOKDUMMYMARKER0";
pub(super) const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";
pub(super) const EXTERNAL_ID: &str = "vtok_dummy_marker_external_0123456789";
pub(super) const ROLE: &str = "arn:aws:iam::123456789012:role/Deployer";

pub(super) fn input() -> AwsStsBindingInput {
    serde_json::from_value(serde_json::json!({
        "role_arn": ROLE,
        "region": "us-east-1",
        "max_duration_seconds": 1800,
        "external_id": EXTERNAL_ID,
    }))
    .unwrap()
}

pub(super) async fn aws_connection(
    broker: &ConnectionBroker,
    organization: &OrganizationId,
) -> String {
    let connection = broker
        .create_connection(organization, create("aws"))
        .await
        .unwrap();
    broker
        .set_connection_configuration(
            organization,
            &connection.connection_id,
            BTreeMap::from([
                ("region".to_string(), "us-east-1".to_string()),
                ("access_key_id".to_string(), AKID.to_string()),
                ("secret_access_key".to_string(), SECRET.to_string()),
            ]),
            Vec::new(),
        )
        .await
        .unwrap();
    broker
        .update_policy(
            organization,
            &connection.connection_id,
            Shareability::Private,
            2,
            Some(MaterializationPolicy::DerivedShortLived),
        )
        .await
        .unwrap();
    connection.connection_id
}

#[tokio::test]
async fn a_binding_is_sealed_whole_and_opens_only_for_its_connection() {
    let (db, broker) = broker().await;
    let organization = OrganizationId::new();
    let first = aws_connection(&broker, &organization).await;
    let second = aws_connection(&broker, &organization).await;
    let view = broker
        .put_aws_sts_binding(&organization, &first, input())
        .await
        .unwrap();
    assert_eq!(view.role_arn, ROLE);
    assert!(view.external_id && !view.session_policy);

    let rows = sqlx::query("SELECT ciphertext FROM aws_sts_bindings")
        .fetch_all(db.pool())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    let stored: Vec<u8> = rows[0].get("ciphertext");
    let stored = String::from_utf8_lossy(&stored);
    assert!(
        !stored.contains(EXTERNAL_ID) && !stored.contains(ROLE),
        "plaintext at rest"
    );

    // The same ciphertext moved onto another connection does not open.
    sqlx::query("UPDATE aws_sts_bindings SET connection_id = ?")
        .bind(&second)
        .execute(db.pool())
        .await
        .unwrap();
    assert!(broker
        .aws_sts_binding(&organization, &second)
        .await
        .is_err());
    assert!(broker
        .aws_sts_binding(&organization, &first)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_binding_needs_an_aws_connection_and_can_be_removed_once() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let other = broker
        .create_connection(&organization, create("aws-sts"))
        .await
        .unwrap();
    let refused = broker
        .put_aws_sts_binding(&organization, &other.connection_id, input())
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "invalid_request");

    let id = aws_connection(&broker, &organization).await;
    broker
        .put_aws_sts_binding(&organization, &id, input())
        .await
        .unwrap();
    broker
        .delete_aws_sts_binding(&organization, &id)
        .await
        .unwrap();
    let again = broker
        .delete_aws_sts_binding(&organization, &id)
        .await
        .unwrap_err();
    assert_eq!(again.code(), "binding_not_found");
    // Another organization cannot see that the connection exists.
    let stranger = OrganizationId::new();
    let hidden = broker.aws_sts_binding(&stranger, &id).await.unwrap_err();
    assert_eq!(hidden.code(), "connection_not_found");
}
