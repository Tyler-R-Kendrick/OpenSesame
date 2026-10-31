//! The call end to end against the stand-in: `SigV4` verified with the same
//! crate, the parameters STS would read, and every failure path.

use std::time::Duration as StdDuration;

use secrecy::SecretString;

use super::*;
use crate::aws_sts::endpoint;
use crate::aws_sts::request::AssumeRoleRequest;
use crate::aws_sts::signer::SourceCredential;
use crate::aws_sts::stand_in::{self, Expect, Reply};

const AKID: &str = "AKIAVTOKDUMMYMARKER0";
const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";
const TOKEN: &str = "vtok_dummy_marker_session_0123456789";

fn expect() -> Expect {
    Expect {
        access_key_id: AKID,
        secret: SECRET,
        session_token: Some(TOKEN),
        region: "eu-west-1",
    }
}

fn signer() -> SigV4Signer {
    SigV4Signer::new(
        SourceCredential::new(
            AKID,
            SecretString::from(SECRET),
            Some(SecretString::from(TOKEN)),
        ),
        "eu-west-1",
    )
}

fn request(duration_seconds: u32) -> AssumeRoleRequest {
    AssumeRoleRequest {
        role_arn: "arn:aws:iam::123456789012:role/Deploy".into(),
        role_session_name: "opensesame-0192f3c4".into(),
        duration_seconds,
        policy: None,
        source_identity: "operator".into(),
        external_id: Some(SecretString::from("vtok_dummy_marker_external_id")),
    }
}

async fn call(reply: Reply, duration: u32) -> (Result<AssumedRole, StsFailure>, stand_in::StandIn) {
    let stand_in = stand_in::spawn(expect(), reply).await;
    let endpoint = endpoint::endpoint("eu-west-1", Some(&stand_in.base)).unwrap();
    let invoker = invoker_for(&endpoint).with_timeout(StdDuration::from_millis(500));
    let result = assume_role(
        &invoker,
        &endpoint,
        &signer(),
        &request(duration),
        Utc::now(),
    )
    .await;
    (result, stand_in)
}

#[tokio::test]
async fn a_signed_assume_role_returns_the_minted_credential() {
    let (result, stand_in) = call(Reply::Assume { expires_in: 900 }, 900).await;
    let assumed = result.expect("minted");
    assert_eq!(
        assumed.credentials.access_key_id,
        stand_in::MINTED_ACCESS_KEY_ID
    );
    assert_eq!(assumed.request_id, stand_in::REQUEST_ID);
    let hits = stand_in.hits();
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert!(
        hit.signature_valid,
        "SigV4 did not verify: {}",
        hit.raw.lines().next().unwrap_or("")
    );
    assert_eq!(hit.security_token.as_deref(), Some(TOKEN));
    assert_eq!(hit.form["Action"], "AssumeRole");
    assert_eq!(hit.form["RoleArn"], "arn:aws:iam::123456789012:role/Deploy");
    assert_eq!(hit.form["RoleSessionName"], "opensesame-0192f3c4");
    assert_eq!(hit.form["DurationSeconds"], "900");
    assert_eq!(hit.form["SourceIdentity"], "operator");
    assert_eq!(hit.form["ExternalId"], "vtok_dummy_marker_external_id");
    assert!(!hit.form.contains_key("Policy"));
    // The secret key itself never travels.
    assert!(!hit.raw.contains(SECRET), "the secret key went on the wire");
}

#[tokio::test]
async fn a_signature_under_the_wrong_secret_does_not_verify() {
    let stand_in = stand_in::spawn(
        Expect {
            secret: "vtok_dummy_marker_another_secret",
            ..expect()
        },
        Reply::Assume { expires_in: 900 },
    )
    .await;
    let endpoint = endpoint::endpoint("eu-west-1", Some(&stand_in.base)).unwrap();
    let invoker = invoker_for(&endpoint);
    let _ = assume_role(&invoker, &endpoint, &signer(), &request(900), Utc::now()).await;
    assert!(!stand_in.hits()[0].signature_valid);
}

#[tokio::test]
async fn each_sts_error_maps_to_its_code_and_access_denied_is_not_retried() {
    let table = [
        (403, "AccessDenied", StsFailure::AccessDenied),
        (403, "ExpiredToken", StsFailure::ExpiredSource),
        (403, "InvalidClientTokenId", StsFailure::ExpiredSource),
        (403, "RegionDisabledException", StsFailure::RegionDisabled),
        (400, "Throttling", StsFailure::Throttled),
        (503, "ServiceUnavailable", StsFailure::Unreachable),
    ];
    for (status, code, expected) in table {
        let (result, stand_in) = call(Reply::Error { status, code }, 900).await;
        assert_eq!(result.map(|_| ()), Err(expected), "{code}");
        assert_eq!(stand_in.hits().len(), 1, "{code}: exactly one attempt");
    }
}

#[tokio::test]
async fn an_untrustworthy_answer_is_refused() {
    let cases = [
        (Reply::Oversize, StsFailure::MalformedResponse),
        (Reply::Redirect, StsFailure::MalformedResponse),
        (Reply::Garbage, StsFailure::MalformedResponse),
        (Reply::Hang, StsFailure::Unreachable),
        (
            Reply::Assume { expires_in: -30 },
            StsFailure::MalformedResponse,
        ),
        (
            Reply::Assume { expires_in: 3600 },
            StsFailure::MalformedResponse,
        ),
    ];
    for (reply, expected) in cases {
        let label = format!("{reply:?}");
        let (result, _) = call(reply, 900).await;
        assert_eq!(result.map(|_| ()), Err(expected), "{label}");
    }
}

#[tokio::test]
async fn nothing_listens_means_unreachable() {
    let endpoint = endpoint::endpoint("eu-west-1", Some("http://127.0.0.1:9")).unwrap();
    let invoker = invoker_for(&endpoint).with_timeout(StdDuration::from_millis(500));
    let result = assume_role(&invoker, &endpoint, &signer(), &request(900), Utc::now()).await;
    assert_eq!(result.map(|_| ()), Err(StsFailure::Unreachable));
}
