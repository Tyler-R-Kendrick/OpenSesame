//! What the bearer opens once a page holds it: the plugin routes, from its
//! own origin, until it is revoked — and nothing else on the daemon.

use super::*;

#[tokio::test]
async fn the_bearer_is_refused_from_another_origin_and_without_one() {
    let f = fixture();
    f.install("surrogate-proxy");
    let token = f.paired(PAGES).await;
    for origin in [OTHER, "http://localhost:5180"] {
        let (status, _, headers) =
            call(&f.app, browser("GET", "/v1/plugins", &token, origin, None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{origin}");
        assert_eq!(allowed_origin(&headers), None);
    }
    let put = browser(
        "PUT",
        "/v1/plugins/surrogate-proxy",
        &token,
        OTHER,
        Some(json!({ "enabled": true })),
    );
    assert_eq!(call(&f.app, put).await.0, StatusCode::UNAUTHORIZED);
    let bare = Request::builder()
        .uri("/v1/plugins")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&f.app, bare).await.0, StatusCode::UNAUTHORIZED);
    assert!(!PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
}

#[tokio::test]
async fn the_bearer_opens_no_other_daemon_route() {
    let f = fixture();
    let token = f.paired(PAGES).await;
    let (status, slot, _) = call(
        &f.app,
        Request::builder()
            .method("POST")
            .uri("/v1/vault-drive/slots")
            .header("x-opensesame-operator", crate::test_operator_token())
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "url": "https://desk.tail1.ts.net" }).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let snapshot = format!(
        "/v1/vault-drive/slots/{}/snapshot",
        slot["slot"]["slot"].as_str().unwrap()
    );
    let body = json!({});
    for (method, uri) in [
        ("POST", "/v1/fill"),
        ("POST", "/v1/fill/match"),
        ("POST", "/v1/invoke_through"),
        ("POST", "/v1/mint"),
        ("POST", "/v1/discover"),
        ("GET", "/v1/vault-drive/slots"),
        ("GET", snapshot.as_str()),
        ("PUT", snapshot.as_str()),
        ("GET", "/v1/toolbar/status"),
        ("POST", "/v1/mint_capability"),
    ] {
        let (status, _, headers) = call(
            &f.app,
            browser(method, uri, &token, PAGES, Some(body.clone())),
        )
        .await;
        assert!(
            status.is_client_error() || status.is_server_error(),
            "{method} {uri} answered {status}"
        );
        assert_ne!(status, StatusCode::OK, "{method} {uri}");
        assert_eq!(allowed_origin(&headers), None, "{method} {uri}");
    }
}

#[tokio::test]
async fn cors_answers_only_the_bound_origin_exactly() {
    let f = fixture();
    let preflight = |origin: &str, private: bool| {
        let mut builder = Request::builder()
            .method("OPTIONS")
            .uri("/v1/plugins/surrogate-proxy")
            .header("origin", origin)
            .header("access-control-request-method", "PUT")
            .header(
                "access-control-request-headers",
                "authorization, content-type",
            );
        if private {
            builder = builder.header("access-control-request-private-network", "true");
        }
        builder.body(Body::empty()).unwrap()
    };
    let (status, _, headers) = call(&f.app, preflight(PAGES, false)).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "nobody paired, nobody answered"
    );
    assert_eq!(allowed_origin(&headers), None);
    f.code_for(PAGES);
    let (status, _, headers) = call(&f.app, preflight(PAGES, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(allowed_origin(&headers), Some(PAGES));
    assert!(headers.get_all(header::VARY).iter().any(|v| v == "Origin"));
    assert!(headers
        .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        .is_none());
    assert_eq!(headers["access-control-allow-private-network"], "true");
    let methods = headers[header::ACCESS_CONTROL_ALLOW_METHODS]
        .to_str()
        .unwrap();
    assert!(methods.contains("PUT") && !methods.contains('*'));
    for other in [
        OTHER,
        "https://tyler-r-kendrick.github.io.attacker.example",
        "null",
    ] {
        let (status, _, headers) = call(&f.app, preflight(other, true)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{other}");
        assert_eq!(allowed_origin(&headers), None);
        assert!(headers
            .get("access-control-allow-private-network")
            .is_none());
    }
}

#[tokio::test]
async fn unpair_at_the_terminal_revokes_the_bearer() {
    let f = fixture();
    let token = f.paired(PAGES).await;
    assert_eq!(f.pairings().unpair(Some(PAGES)).unwrap(), 1);
    let (status, _, headers) =
        call(&f.app, browser("GET", "/v1/plugins", &token, PAGES, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(allowed_origin(&headers), None);
}

#[tokio::test]
async fn a_page_forgetting_its_pairing_revokes_its_own_bearer_only() {
    let f = fixture();
    let first = f.paired(PAGES).await;
    let second = f.paired(PAGES).await;
    let delete =
        |token: &str, origin: &str| browser("DELETE", "/v1/plugins/pairing", token, origin, None);
    assert_eq!(
        call(&f.app, delete(&first, OTHER)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&f.app, delete(&first, PAGES)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&f.app, delete(&first, PAGES)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let get = |token: &str| browser("GET", "/v1/plugins", token, PAGES, None);
    assert_eq!(call(&f.app, get(&first)).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&f.app, get(&second)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_bearer_switches_only_what_is_installed_and_still_matches_its_pin() {
    let f = fixture();
    let token = f.paired(PAGES).await;
    let put = |on: bool| {
        browser(
            "PUT",
            "/v1/plugins/surrogate-proxy",
            &token,
            PAGES,
            Some(json!({ "enabled": on })),
        )
    };
    let (status, body, _) = call(&f.app, put(true)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "not_installed");
    let bin = f.install("surrogate-proxy");
    let (status, body, headers) = call(&f.app, put(true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["active"], true);
    assert_eq!(allowed_origin(&headers), Some(PAGES));
    call(&f.app, put(false)).await;
    std::fs::write(bin, b"swapped").unwrap();
    let (status, body, _) = call(&f.app, put(true)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "pin_mismatch");
    assert!(!PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
    let install = browser(
        "PUT",
        "/v1/plugins/surrogate-proxy",
        &token,
        PAGES,
        Some(json!({ "enabled": true, "sha256": "0".repeat(64) })),
    );
    assert!(call(&f.app, install).await.0.is_client_error());
}

#[tokio::test]
async fn nothing_secret_reaches_the_pairings_file() {
    let f = fixture();
    let code = f.code_for(PAGES);
    let (_, body, _) = call(&f.app, exchange_request(&code, Some(PAGES))).await;
    let token = body["token"].as_str().unwrap();
    let text = std::fs::read_to_string(f.pairings().path()).unwrap();
    assert!(!text.contains(token));
    assert!(!text.contains(&code));
}
