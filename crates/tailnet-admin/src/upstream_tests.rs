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
