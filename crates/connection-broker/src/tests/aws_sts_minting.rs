//! The AWS mint in the broker (ADR 0217): an unbound connection stays
//! unmintable, and a bound one assumes its role through a `SigV4`-verified STS.

use super::aws_sts_binding::{aws_connection, input, AKID, EXTERNAL_ID, ROLE, SECRET};
use super::*;
use crate::aws_sts::stand_in::{self, Expect, Reply};
use crate::MintCaller;

/// A caller the daemon forwarded for a local process: the actor carries the
/// process, the principal does not.
const FORWARDED: MintCaller<'static> = MintCaller {
    principal: "principal:alice",
    actor: "principal:alice on_behalf_of=uid:1000,pid:4242",
};

#[tokio::test]
async fn an_unbound_aws_connection_stays_unmintable() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let id = aws_connection(&broker, &organization).await;
    let error = broker
        .mint_derived_token(&organization, &id, "operator", None)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "unmintable");
}

#[tokio::test]
async fn a_bound_connection_mints_with_its_callers_principal_as_source_identity() {
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
        .mint_derived_token_for(&organization, &id, FORWARDED, None, Some(1800))
        .await
        .unwrap();
    let hit = &stand_in.hits()[0];
    assert!(hit.signature_valid);
    assert!(hit.security_token.is_none());
    assert_eq!(hit.form["SourceIdentity"], "principal=3Aalice");
    assert_eq!(hit.form["DurationSeconds"], "1800");
    assert_eq!(hit.form["RoleArn"], ROLE);
    assert_eq!(hit.form["ExternalId"], EXTERNAL_ID);
    assert_eq!(minted.kind, "aws_sts_assume_role");
    assert_eq!(minted.actor, FORWARDED.actor);
    assert_eq!(
        minted.receipt.as_ref().unwrap().source_identity,
        "principal=3Aalice",
        "STS hears the principal, never the process note"
    );
    let wire = serde_json::to_string(&minted).unwrap();
    assert!(wire.contains(stand_in::MINTED_ACCESS_KEY_ID), "{wire}");
    for leaked in [AKID, SECRET, EXTERNAL_ID] {
        assert!(!wire.contains(leaked), "{leaked} in the mint response");
    }
    let refused = broker
        .mint_derived_token_for(&organization, &id, FORWARDED, None, Some(3600))
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "invalid_request");
    assert_eq!(
        stand_in.hits().len(),
        1,
        "a refused duration never reaches STS"
    );
}
