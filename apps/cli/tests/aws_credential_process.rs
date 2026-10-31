//! `opensesame-credential-process` against the AWS mint (ADR 0217): the
//! daemon's answer is the Host's real mint shape, serialized by the broker's
//! own `DerivedMaterialization`, and the binary prints the `credential_process`
//! JSON the AWS SDKs read — or nothing at all.
#![cfg(unix)]

mod helper_stub;
mod named;

use helper_stub::{run_helper, spawn_stub_daemon};
use opensesame_connection_broker::aws_sts::{AwsSessionCredentials, MintReceipt};
use opensesame_connection_broker::DerivedMaterialization;

const MINTED_KEY: &str = "ASIAMINTEDDUMMY00001";
const MINTED_SECRET: &str = "MintedDummySecret0123456789abcdefABCDEFGH";
const MINTED_TOKEN: &str = "MintedDummySessionToken0123456789+/abcdef==";

fn aws_bin() -> String {
    named::binary("opensesame-credential-process")
}

/// What `POST /api/v1/connections/{id}/mint` answers for an AWS mint.
fn host_mint_body() -> String {
    serde_json::to_string(&DerivedMaterialization {
        connection_id: "conn_aws".into(),
        provider_id: "aws".into(),
        kind: "aws_sts_assume_role".into(),
        derived_token: MINTED_TOKEN.into(),
        expires_at: "2026-10-17T12:30:00Z".into(),
        subject: "operator".into(),
        actor: "operator".into(),
        issued_at: "2026-10-17T12:00:00Z".into(),
        aws: Some(AwsSessionCredentials {
            access_key_id: MINTED_KEY.into(),
            secret_access_key: MINTED_SECRET.into(),
            session_token: MINTED_TOKEN.into(),
        }),
        receipt: Some(MintReceipt {
            grant_id: "0192f3c4".into(),
            role_arn: "arn:aws:iam::123456789012:role/Deployer".into(),
            role_session_name: "opensesame-0192f3c4".into(),
            source_identity: "operator".into(),
            duration_seconds: 1800,
            expires_at: "2026-10-17T12:30:00Z".into(),
            request_id: "c6104cbe-af31-11e0-8154-cbc7ccf896c7".into(),
        }),
    })
    .expect("mint shape")
}

#[test]
fn the_host_mint_shape_prints_the_credential_process_json() {
    let stub = spawn_stub_daemon(200, &host_mint_body(), 1);
    let out = run_helper(
        &aws_bin(),
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
            ("OPENSESAME_AWS_DURATION_SECONDS", "1800"),
        ],
    );
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        stdout,
        serde_json::json!({
            "Version": 1,
            "AccessKeyId": MINTED_KEY,
            "SecretAccessKey": MINTED_SECRET,
            "SessionToken": MINTED_TOKEN,
            "Expiration": "2026-10-17T12:30:00Z",
        })
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let requests = stub.requests.lock().unwrap();
    let asked: serde_json::Value = serde_json::from_str(&requests[0]).unwrap();
    assert_eq!(asked["connection_id"], "conn_aws");
    assert_eq!(asked["duration_seconds"], 1800);
}

#[test]
fn aws_unmintable_fails_closed_with_a_clear_message() {
    let stub = spawn_stub_daemon(422, r#"{"error":"unmintable"}"#, 1);
    let out = run_helper(
        &aws_bin(),
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(
        stderr.contains("unmintable") && stderr.contains("aws-sts-binding"),
        "{stderr}"
    );
}

#[test]
fn an_sts_refusal_or_a_partial_credential_prints_nothing() {
    let partial = host_mint_body().replace(MINTED_SECRET, "");
    for (status, body) in [
        (502, r#"{"error":"aws.sts.access_denied"}"#.to_string()),
        (200, partial),
    ] {
        let stub = spawn_stub_daemon(status, &body, 1);
        let out = run_helper(
            &aws_bin(),
            &[],
            "",
            &[
                ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
                ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
            ],
        );
        assert!(!out.status.success(), "{status}");
        assert!(out.stdout.is_empty(), "{status}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !stderr.contains(MINTED_TOKEN) && !stderr.contains(MINTED_KEY),
            "{stderr}"
        );
    }
}

#[test]
fn a_duration_that_is_not_a_number_is_refused_before_the_daemon() {
    let stub = spawn_stub_daemon(200, &host_mint_body(), 1);
    let out = run_helper(
        &aws_bin(),
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
            ("OPENSESAME_AWS_DURATION_SECONDS", "an hour"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENSESAME_AWS_DURATION_SECONDS"));
    assert!(
        stub.requests.lock().unwrap().is_empty(),
        "nothing may reach the daemon"
    );
}
