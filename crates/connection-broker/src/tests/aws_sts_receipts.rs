//! What a broker mint records (ADR 0217): the receipt event and the deadline.

use super::aws_sts_binding::{aws_connection, input, AKID, EXTERNAL_ID, ROLE, SECRET};
use super::*;
use crate::aws_sts::stand_in::{self, Expect, Reply};

#[tokio::test]
async fn a_mint_records_its_receipt_and_deadline_and_no_source_material() {
    let stand_in = stand_in::spawn(
        Expect {
            access_key_id: AKID,
            secret: SECRET,
            session_token: None,
            region: "us-east-1",
        },
        Reply::Assume { expires_in: 900 },
    )
    .await;
    let (_db, broker) =
        broker_with(key_config().with_aws_sts_endpoint(stand_in.base.clone())).await;
    let organization = OrganizationId::new();
    let id = aws_connection(&broker, &organization).await;
    broker
        .put_aws_sts_binding(&organization, &id, input())
        .await
        .unwrap();
    let minted = broker
        .mint_derived_token_for(
            &organization,
            &id,
            crate::MintCaller::principal("principal:alice"),
            None,
            None,
        )
        .await
        .unwrap();
    assert!(stand_in.hits()[0].signature_valid);
    assert!(stand_in.hits()[0].security_token.is_none());
    assert_eq!(
        stand_in.hits()[0].form["SourceIdentity"],
        "principal=3Aalice"
    );
    let receipt = minted.receipt.clone().expect("receipt");
    assert_eq!(receipt.duration_seconds, 900);
    assert_eq!(receipt.request_id, stand_in::REQUEST_ID);

    let events = broker.events(&organization, &id).await.unwrap();
    let detail: String = events
        .iter()
        .filter_map(|event| event.detail.clone())
        .collect();
    assert!(
        detail.contains(&receipt.grant_id) && detail.contains(ROLE),
        "{detail}"
    );
    for leaked in [
        AKID,
        SECRET,
        EXTERNAL_ID,
        stand_in::MINTED_SECRET,
        stand_in::MINTED_SESSION_TOKEN,
    ] {
        assert!(!detail.contains(leaked), "{leaked} in an event");
    }
    let now = Utc::now();
    let deadlines = broker
        .aws_sts_mint_deadlines(&organization, now, now, 10)
        .await
        .unwrap();
    assert_eq!(deadlines.len(), 1);
    assert_eq!(deadlines[0].grant_id, receipt.grant_id);
    assert_eq!(deadlines[0].connection_id, id);
}
