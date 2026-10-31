//! Malformed public API paths cannot redirect an account bearer to another origin.
#[path = "common/response_limit_stub.rs"]
mod stub;

use std::sync::atomic::Ordering;

use opensesame_provider_bitwarden::{Client, DeviceIdentity, Endpoints, Error};
use stub::Framing;

fn client(base: &str) -> Client {
    Client::new(
        Endpoints::split(base, base).unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap()
}

#[tokio::test]
async fn malformed_get_and_post_paths_cannot_send_a_bearer_to_another_origin() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let other = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let path = format!("@{}/steal", other.base.strip_prefix("http://").unwrap());
        let api = client(&pinned.base);
        let error = if post {
            api.post_json(
                &path,
                "fixture-bearer",
                &serde_json::json!({"proof":"fixture"}),
            )
            .await
            .unwrap_err()
        } else {
            api.get_json(&path, "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::InvalidServerUrl(_)));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 0);
        assert_eq!(other.connections.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn injected_url_credentials_are_rejected_even_when_the_origin_matches() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let path = format!("@{}/userinfo", pinned.base.strip_prefix("http://").unwrap());
        let api = client(&pinned.base);
        let error = if post {
            api.post_json(&path, "fixture-bearer", &serde_json::json!({}))
                .await
                .unwrap_err()
        } else {
            api.get_json(&path, "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::InvalidServerUrl(_)));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn ordinary_requests_keep_the_configured_base_prefix_for_get_and_post() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let api = client(&format!("{}/mounted/api", pinned.base));
        let response = if post {
            api.post_json("/safe?details=1", "fixture-bearer", &serde_json::json!({}))
                .await
                .unwrap()
        } else {
            api.get_json("/safe?details=1", "fixture-bearer")
                .await
                .unwrap()
        };
        assert_eq!(response, serde_json::json!({}));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 1);
        assert_eq!(
            pinned.target.lock().unwrap().as_deref(),
            Some("/mounted/api/safe?details=1")
        );
    }
}

#[tokio::test]
async fn cross_origin_downloads_never_inherit_account_bearers_or_cookies() {
    let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
    let storage = stub::spawn(200, Framing::Length(3), b"abc".to_vec(), false).await;
    let api = client(&pinned.base);
    api.get_json("/safe", "fixture-bearer").await.unwrap();
    assert!(pinned.authorization.load(Ordering::SeqCst));
    // The authenticated response sets a sentinel cookie. Download storage is
    // another port on the same host, so enabling a cookie jar would leak it.
    let bytes = api
        .download(&format!("{}/file", storage.base), 3)
        .await
        .unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(storage.connections.load(Ordering::SeqCst), 1);
    assert!(!storage.authorization.load(Ordering::SeqCst));
    assert!(!storage.cookie.load(Ordering::SeqCst));
}

#[tokio::test]
async fn json_and_download_redirects_never_reach_a_second_origin() {
    for download in [false, true] {
        let sink = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let redirect = stub::redirect(&format!("{}/leak", sink.base)).await;
        let api = client(&redirect.base);
        let error = if download {
            api.download(&format!("{}/file", redirect.base), 3)
                .await
                .unwrap_err()
        } else {
            api.get_json("/safe", "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::RedirectRefused { status: 302, .. }));
        assert_eq!(redirect.connections.load(Ordering::SeqCst), 1);
        assert_eq!(sink.connections.load(Ordering::SeqCst), 0);
    }
}
