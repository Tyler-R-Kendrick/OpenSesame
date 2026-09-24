use super::*;

#[test]
fn property_https_and_loopback_http_are_accepted() {
    for ok in [
        "https://fga.example",
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://[::1]:8080",
    ] {
        assert!(assert_pdp_base_url(ok).is_ok(), "{ok}");
    }
}

#[test]
fn adversarial_cleartext_remote_and_userinfo_are_refused() {
    for bad in [
        "http://evil.example/check",
        "https://user:secret@fga.example",
        "ftp://127.0.0.1",
        "not-a-url",
    ] {
        assert!(assert_pdp_base_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn chaos_missing_allowed_never_becomes_allow() {
    for body in [
        json!({}),
        json!({"allowed": false}),
        json!({"allowed": "yes"}),
    ] {
        let allowed = parse_check_response(&body).unwrap_or(false);
        assert!(!allowed, "{body}");
    }
}

#[test]
fn contract_http_guard_is_in_source_before_send() {
    let src = include_str!("lib.rs");
    let production = src.split("#[cfg(test)]").next().unwrap();
    for method in [
        "health",
        "create_store",
        "write_authorization_model",
        "write_tuples",
        "check_tuple",
    ] {
        let body = production
            .split(&format!("pub async fn {method}"))
            .nth(1)
            .unwrap_or_else(|| panic!("{method}"));
        let body = body.split("\n    pub async fn ").next().unwrap();
        let pin = body
            .find("assert_pdp_base_url(&self.base)")
            .unwrap_or_else(|| panic!("{method} guard"));
        let send = body
            .find(".send()")
            .unwrap_or_else(|| panic!("{method} send"));
        assert!(pin < send, "{method}");
    }
}

#[tokio::test]
#[ignore = "requires live OpenFGA on OPENSESAME_OPENFGA_URL"]
async fn live_openfga_check_demo_conn() {
    let base = std::env::var("OPENSESAME_OPENFGA_URL").expect("OPENSESAME_OPENFGA_URL");
    let (client, _sid) = bootstrap_demo_store(&base).await.expect("bootstrap");
    let allowed = client
        .check_tuple(&TupleKey {
            user: "user:demo".into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        })
        .await
        .unwrap();
    assert!(allowed);
    let denied = client
        .check_tuple(&TupleKey {
            user: "user:attacker".into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        })
        .await
        .unwrap();
    assert!(!denied);
}
