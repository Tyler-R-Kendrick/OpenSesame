use super::http_security::{apply_http_security, browser_cors_layer};
use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    routing::get,
    Router,
};
use tower::ServiceExt;

#[tokio::test]
async fn global_headers_never_grant_browser_or_private_network_access() {
    for origin in [
        "https://tyler-r-kendrick.github.io",
        "https://paired.example",
        "null",
    ] {
        let app = apply_http_security(
            Router::new().route("/operator", get(|| async { "ok" })),
            &[origin.into()],
            true,
        );
        let res = app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/operator")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "x-opensesame-operator",
                    )
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        for name in [
            "access-control-allow-origin",
            "access-control-allow-private-network",
            "access-control-allow-credentials",
        ] {
            assert!(res.headers().get(name).is_none(), "{name}");
        }
        assert_eq!(res.headers()["x-content-type-options"], "nosniff");
        assert_eq!(res.headers()["x-frame-options"], "DENY");
        assert!(res.headers().contains_key("strict-transport-security"));
    }
}

#[tokio::test]
async fn paired_route_preflight_is_credentialless_and_excludes_operator() {
    let app = Router::new()
        .route("/paired", get(|| async { "ok" }))
        .layer(browser_cors_layer(&["https://paired.example".into()]));
    for origin in ["https://paired.example", "https://unpaired.example", "null"] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/paired")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,dpop,x-opensesame-operator",
                    )
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            res.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_some(),
            origin == "https://paired.example"
        );
        assert!(!res.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()
            .unwrap()
            .contains("operator"));
        assert!(!res
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
        assert!(!res
            .headers()
            .contains_key("access-control-allow-private-network"));
        assert!(res.headers()[header::VARY]
            .to_str()
            .unwrap()
            .contains("origin"));
    }
}

#[tokio::test]
async fn normal_nonbrowser_response_keeps_security_headers() {
    let app = apply_http_security(
        Router::new().route("/health", get(|| async { "ok" })),
        &[],
        false,
    );
    let res = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!res
        .headers()
        .contains_key(header::STRICT_TRANSPORT_SECURITY));
}
