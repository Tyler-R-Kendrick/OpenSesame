use super::*;

/// The row must track the catalog: read as a file at compile time, never the
/// broker crate, so the daemon's dependency quarantine is untouched.
#[test]
fn the_egress_row_tracks_the_catalog() {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../spec/connectors/catalog.json"))
            .expect("catalog parses");
    let row = catalog["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == EGRESS_RULE.provider_id)
        .expect("tailscale is in the catalog");
    assert_eq!(row["egress"]["scheme"], EGRESS_RULE.scheme);
    let hosts: Vec<&str> = row["egress"]["authorities"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(hosts, EGRESS_RULE.hosts);
    for operation in ["device.list", "device.authorize", "auth_key.create"] {
        assert!(
            row["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o == operation),
            "{operation} is a catalog operation"
        );
    }
}

#[test]
fn production_reaches_exactly_api_tailscale_com() {
    let up = Upstream::production();
    assert_eq!(up.base, "https://api.tailscale.com");
    let denied = up.invoker.preflight(InvokeRequest {
        provider_id: "tailscale".into(),
        method: "GET".into(),
        url: "https://api.tailscale.com.evil.test/api/v2/tailnet/-/devices".into(),
        headers: vec![],
        body: None,
        subject: None,
        actor: None,
    });
    assert!(matches!(denied, Err(InvokeError::EgressDenied { .. })));
    let plain = up.invoker.preflight(InvokeRequest {
        provider_id: "tailscale".into(),
        method: "GET".into(),
        url: "http://api.tailscale.com/api/v2/tailnet/-/devices".into(),
        headers: vec![],
        body: None,
        subject: None,
        actor: None,
    });
    assert!(matches!(plain, Err(InvokeError::HttpsRequired(_))));
}

#[test]
fn only_a_loopback_http_base_stands_in() {
    assert!(Upstream::loopback("http://127.0.0.1:8080").is_some());
    assert!(Upstream::loopback("http://localhost:9").is_some());
    for base in [
        "https://127.0.0.1:8080",
        "http://10.0.0.1:80",
        "http://api.tailscale.com",
        "http://127.0.0.1.evil.test:1",
    ] {
        assert!(Upstream::loopback(base).is_none(), "{base}");
    }
}

#[tokio::test]
async fn a_call_before_connect_sends_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let store = AdminStore::at(tmp.path());
    let up = Upstream::loopback("http://127.0.0.1:9").unwrap();
    let error = up
        .call(&store, "GET", "/tailnet/-/devices", None)
        .await
        .unwrap_err();
    assert!(matches!(error, AdminError::NotConnected));
}

#[test]
fn debug_names_the_base_and_nothing_else() {
    let shown = format!("{:?}", Upstream::production());
    assert!(shown.contains("api.tailscale.com"));
    assert!(!shown.contains("token"));
}

#[tokio::test]
async fn oauth_cache_is_isolated_between_directories_and_credential_rotation() {
    use crate::Credential;
    use axum::{routing::post, Json, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let app = Router::new().route("/api/v2/oauth/token", post(move || {
        let count = counted.fetch_add(1, Ordering::SeqCst) + 1;
        async move { Json(serde_json::json!({ "access_token": format!("access-{count}"), "expires_in": 3600 })) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let up = Upstream::loopback(&base).unwrap();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let first = AdminStore::at(a.path());
    let other = AdminStore::at(b.path());
    let credential = Credential {
        kind: CredentialKind::Oauth,
        client_id: "sameClient".into(),
    };
    let secret = SecretString::from("tskey-client-first-0123456789abcdef".to_owned());
    let first_config = first
        .connect("customer.example", credential.clone(), &secret, 1)
        .unwrap();
    let other_config = other
        .connect("customer.example", credential.clone(), &secret, 1)
        .unwrap();
    assert_eq!(
        up.token(&first, &first_config)
            .await
            .unwrap()
            .expose_secret(),
        "access-1"
    );
    assert_eq!(
        up.token(&first, &first_config)
            .await
            .unwrap()
            .expose_secret(),
        "access-1"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        up.token(&other, &other_config)
            .await
            .unwrap()
            .expose_secret(),
        "access-2"
    );
    assert_eq!(
        up.token(&first, &first_config)
            .await
            .unwrap()
            .expose_secret(),
        "access-3"
    );
    let replacement = SecretString::from("tskey-client-second-0123456789abcdef".to_owned());
    let current = first
        .connect("customer.example", credential, &replacement, 2)
        .unwrap();
    assert!(up.token(&first, &first_config).await.is_err());
    assert_eq!(
        up.token(&first, &current).await.unwrap().expose_secret(),
        "access-4"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    server.abort();
}
