//! Response admission must stop at the cap without awaiting an unbounded peer.
#[path = "common/response_limit_stub.rs"]
mod stub;

use std::time::Duration;

use opensesame_provider_bitwarden::{Client, DeviceIdentity, Endpoints, Error};
use stub::{Framing, Stub};

const JSON_LIMIT: usize = 16 * 1024 * 1024;

fn client(stub: &Stub) -> Client {
    Client::new(
        Endpoints::from_server_url(&stub.base).unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap()
}

async fn json(stub: &Stub) -> Result<serde_json::Value, Error> {
    tokio::time::timeout(
        Duration::from_secs(5),
        client(stub).get_json("/limits", "fixture-token"),
    )
    .await
    .expect("the byte cap must refuse before the peer closes its body")
}

async fn binary(stub: &Stub, limit: usize) -> Result<Vec<u8>, Error> {
    tokio::time::timeout(
        Duration::from_secs(5),
        client(stub).download(&format!("{}/file?signature=fixture", stub.base), limit),
    )
    .await
    .expect("the byte cap must refuse before the peer closes its body")
}

fn padded_json(length: usize) -> Vec<u8> {
    let mut body = br#"{"ok":true}"#.to_vec();
    body.resize(length, b' ');
    body
}

#[tokio::test]
async fn json_accepts_the_exact_cap_for_all_supported_framing() {
    for framing in [
        Framing::Length(JSON_LIMIT as u64),
        Framing::Chunked,
        Framing::Close,
    ] {
        let peer = stub::spawn(200, framing, padded_json(JSON_LIMIT), false).await;
        assert_eq!(json(&peer).await.unwrap(), serde_json::json!({"ok":true}));
    }
}

#[tokio::test]
async fn a_declared_oversized_json_body_is_refused_before_any_body_arrives() {
    let peer = stub::spawn(
        200,
        Framing::Length(JSON_LIMIT as u64 + 1),
        Vec::new(),
        true,
    )
    .await;
    let error = json(&peer).await.unwrap_err();
    assert!(matches!(error, Error::MalformedResponse { .. }));
    assert!(error
        .to_string()
        .contains("response body exceeded 16777216 bytes"));
}

#[tokio::test]
async fn json_counts_actual_chunks_and_refuses_cap_plus_one_without_eof() {
    for framing in [
        Framing::Chunked,
        Framing::Close,
        Framing::ChunkedWithLength(1),
    ] {
        let peer = stub::spawn(200, framing, padded_json(JSON_LIMIT + 1), true).await;
        let error = json(&peer).await.unwrap_err();
        // A conflicting framing header may instead be rejected by HTTP admission.
        assert!(matches!(
            error,
            Error::MalformedResponse { .. } | Error::Transport { .. }
        ));
    }
}

#[tokio::test]
async fn json_error_responses_are_bounded_before_error_classification() {
    let peer = stub::spawn(401, Framing::Chunked, vec![b' '; JSON_LIMIT + 1], true).await;
    assert!(matches!(
        json(&peer).await.unwrap_err(),
        Error::MalformedResponse { .. }
    ));
    let small = br#"{"error":"invalid_grant"}"#.to_vec();
    let peer = stub::spawn(401, Framing::Length(small.len() as u64), small, false).await;
    assert!(matches!(
        json(&peer).await.unwrap_err(),
        Error::Authentication(_)
    ));
}

#[tokio::test]
async fn json_redirects_are_refused_without_reading_the_body() {
    let peer = stub::spawn(
        302,
        Framing::Length(JSON_LIMIT as u64 + 1),
        Vec::new(),
        true,
    )
    .await;
    assert!(matches!(
        json(&peer).await.unwrap_err(),
        Error::RedirectRefused { status: 302, .. }
    ));
}

#[tokio::test]
async fn binary_accepts_the_exact_cap_and_empty_or_unbounded_caller_limits() {
    for framing in [Framing::Length(3), Framing::Chunked, Framing::Close] {
        let peer = stub::spawn(200, framing, b"abc".to_vec(), false).await;
        assert_eq!(binary(&peer, 3).await.unwrap(), b"abc");
    }
    let peer = stub::spawn(200, Framing::Length(0), Vec::new(), false).await;
    assert!(binary(&peer, 0).await.unwrap().is_empty());
    let peer = stub::spawn(200, Framing::Length(3), b"abc".to_vec(), false).await;
    assert_eq!(binary(&peer, usize::MAX).await.unwrap(), b"abc");
}

#[tokio::test]
async fn binary_rejects_declared_excess_before_any_body_arrives() {
    let peer = stub::spawn(200, Framing::Length(4), Vec::new(), true).await;
    let error = binary(&peer, 3).await.unwrap_err();
    assert!(matches!(error, Error::MalformedResponse { .. }));
    assert!(error.to_string().contains("download exceeded 3 bytes"));
    assert!(!error.to_string().contains("signature=fixture"));
}

#[tokio::test]
async fn binary_counts_actual_chunks_instead_of_trusting_an_optional_length() {
    for framing in [
        Framing::Chunked,
        Framing::Close,
        Framing::ChunkedWithLength(1),
    ] {
        let peer = stub::spawn(200, framing, b"abcd".to_vec(), true).await;
        assert!(matches!(
            binary(&peer, 3).await.unwrap_err(),
            Error::MalformedResponse { .. } | Error::Transport { .. }
        ));
    }
    let peer = stub::spawn(200, Framing::Close, b"a".to_vec(), true).await;
    assert!(matches!(
        binary(&peer, 0).await.unwrap_err(),
        Error::MalformedResponse { .. }
    ));
}

#[tokio::test]
async fn http_message_framing_remains_authoritative_for_an_understated_length() {
    let peer = stub::spawn(200, Framing::Length(3), b"abcTRAILING".to_vec(), false).await;
    assert_eq!(binary(&peer, 3).await.unwrap(), b"abc");
    // Bytes after Content-Length belong outside this HTTP body; they are not
    // silently appended to the admitted result.
    let peer = stub::spawn(200, Framing::Length(2), b"{}TRAILING".to_vec(), false).await;
    assert_eq!(json(&peer).await.unwrap(), serde_json::json!({}));
}

#[tokio::test]
async fn truncated_or_invalid_http_lengths_fail_as_transport_errors() {
    for framing in [Framing::Length(4), Framing::InvalidLength] {
        let peer = stub::spawn(200, framing, b"abc".to_vec(), false).await;
        assert!(matches!(
            binary(&peer, 4).await.unwrap_err(),
            Error::Transport { .. }
        ));
    }
}

#[tokio::test]
async fn download_status_rejection_never_waits_for_the_body() {
    for status in [302, 401, 404, 500] {
        let peer = stub::spawn(
            status,
            Framing::Length(JSON_LIMIT as u64 + 1),
            Vec::new(),
            true,
        )
        .await;
        let error = binary(&peer, 3).await.unwrap_err();
        if status == 302 {
            assert!(matches!(error, Error::RedirectRefused { status: 302, .. }));
        } else {
            assert!(matches!(error, Error::Api { .. }));
        }
    }
}

#[tokio::test]
async fn failed_download_transport_errors_never_print_signed_url_credentials() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let api = Client::new(
        Endpoints::from_server_url("http://127.0.0.1").unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap();
    let error = api
        .download(
            &format!("http://{address}/path-capability-fixture?signature=query-capability-fixture"),
            3,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Transport { .. }));
    for shown in [error.to_string(), format!("{error:?}")] {
        assert!(!shown.contains("path-capability-fixture"));
        assert!(!shown.contains("query-capability-fixture"));
    }
}

#[tokio::test]
async fn download_status_and_limit_errors_never_print_path_or_query_capabilities() {
    for (status, length) in [(302, 0), (401, 0), (500, 0), (200, 4)] {
        let peer = stub::spawn(status, Framing::Length(length), b"abcd".to_vec(), false).await;
        let error = client(&peer)
            .download(
                &format!(
                    "{}/path-capability-fixture?signature=query-capability-fixture",
                    peer.base
                ),
                3,
            )
            .await
            .unwrap_err();
        for shown in [error.to_string(), format!("{error:?}")] {
            assert!(!shown.contains("path-capability-fixture"));
            assert!(!shown.contains("query-capability-fixture"));
        }
    }
}
