use super::*;
use crate::identity_mapping::MemoryPrincipalMapper;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::app_state::test_env::lock()
}

fn test_cfg() -> CalloutConfig {
    CalloutConfig {
        shared_secret: "callout-test-secret".into(),
        issuer_allowlist: "https://identity.test,https://idp.example".into(),
    }
}

#[tokio::test]
async fn deny_unknown_issuer() {
    let cfg = test_cfg();
    let resp = decide_nats_callout(
        &cfg,
        NatsCalloutRequest {
            issuer: "https://evil.example".into(),
            subject: "sub-1".into(),
            user_nkey: "UTEST".into(),
            server_id: "NTEST".into(),
            email: None,
            join_by_email: false,
            project_ids: vec![],
            token_claims: None,
        },
        Some(MappedPrincipal {
            principal_id: "prn_x".into(),
            provisional: false,
            assurance: "verified".into(),
            issuer: "https://evil.example".into(),
            subject: "sub-1".into(),
        }),
    );
    assert_eq!(resp.decision, "deny");
    assert_eq!(resp.error, Some("unknown_issuer"));
}

#[tokio::test]
async fn deny_email_join() {
    let cfg = test_cfg();
    let mapper = MemoryPrincipalMapper::new();
    mapper.insert(
        "https://identity.test",
        "sub-1",
        MappedPrincipal {
            principal_id: "prn_mapped".into(),
            provisional: false,
            assurance: "verified".into(),
            issuer: "https://identity.test".into(),
            subject: "sub-1".into(),
        },
    );
    // Even if a mapping exists for issuer+subject, email join flag denies.
    let _ = mapper;
    let resp = decide_nats_callout(
        &cfg,
        NatsCalloutRequest {
            issuer: "https://identity.test".into(),
            subject: "sub-1".into(),
            user_nkey: String::new(),
            server_id: String::new(),
            email: Some("alice@example.com".into()),
            join_by_email: true,
            project_ids: vec!["proj_a".into()],
            token_claims: None,
        },
        Some(MappedPrincipal {
            principal_id: "prn_mapped".into(),
            provisional: false,
            assurance: "verified".into(),
            issuer: "https://identity.test".into(),
            subject: "sub-1".into(),
        }),
    );
    assert_eq!(resp.decision, "deny");
    assert_eq!(resp.error, Some("email_join_forbidden"));
}

#[tokio::test]
async fn allow_mapped_principal() {
    let cfg = test_cfg();
    let resp = decide_nats_callout(
        &cfg,
        NatsCalloutRequest {
            issuer: "https://identity.test".into(),
            subject: "oidc-sub-9".into(),
            user_nkey: "UBO2MQV67TQTVIRV3XFTEZOACM4WLOCMCDMAWN5QVN5PI2N6JHTVDRON".into(), // gitleaks:allow -- public test NKey
            server_id: "NB5FCQYBGNXSL27AGZYUX5QZ2KKIFUKVDZCL5R7NIUS4562JT4WEWKQV".into(),
            email: None,
            join_by_email: false,
            project_ids: vec!["proj_a".into()],
            token_claims: None,
        },
        Some(MappedPrincipal {
            principal_id: "prn_mapped".into(),
            provisional: false,
            assurance: "verified".into(),
            issuer: "https://identity.test".into(),
            subject: "oidc-sub-9".into(),
        }),
    );
    assert_eq!(resp.decision, "allow");
    assert_eq!(resp.principal_id.as_deref(), Some("prn_mapped"));
    assert_eq!(resp.provisional, Some(false));
    let perms = resp.permissions.expect("permissions");
    assert_eq!(
        perms.publish,
        vec!["opensesame.callout.principal.prn_mapped.>".to_string()]
    );
    assert_eq!(
        resp.user_nkey.as_deref(),
        Some("UBO2MQV67TQTVIRV3XFTEZOACM4WLOCMCDMAWN5QVN5PI2N6JHTVDRON")
    );
}

#[tokio::test]
async fn deny_unmapped_even_with_allowed_issuer() {
    let cfg = test_cfg();
    let resp = decide_nats_callout(
        &cfg,
        NatsCalloutRequest {
            issuer: "https://identity.test".into(),
            subject: "unknown-sub".into(),
            user_nkey: String::new(),
            server_id: String::new(),
            email: None,
            join_by_email: false,
            project_ids: vec![],
            token_claims: None,
        },
        None,
    );
    assert_eq!(resp.decision, "deny");
    assert_eq!(resp.error, Some("unmapped_principal"));
}

#[test]
fn source_never_uses_connection_key() {
    let src = include_str!("nats_callout.rs");
    opensesame_host_core::pact::assert_source_order(src, &["project_ids: vec![]"]);
    let code = src.split("#[cfg(test)]").next().unwrap_or(src);
    assert!(
        !code.contains("ENV_CONNECTION") && !code.contains("BrokerConfig::from_env"),
        "callout production path must not load connection seal material"
    );
}

#[tokio::test]
async fn http_callout_requires_shared_secret() {
    let _guard = env_lock();
    use crate::app_state;
    use crate::config::Args;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
    std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET");
    let state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/nats/auth/callout")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"issuer":"https://identity.test","subject":"s1"}"#,
        ))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    match prev {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
    }
    let _ = to_bytes(response.into_body(), 1024).await;
}

#[tokio::test]
async fn http_callout_allow_never_includes_system_subjects() {
    let _guard = env_lock();
    use crate::app_state;
    use crate::config::Args;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use opensesame_authz::permissions_include_system;
    use tower::ServiceExt;

    let prev_secret = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
    let prev_issuers = std::env::var_os("OPENSESAME_NATS_CALLOUT_ISSUERS");
    std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "callout-http-test");
    std::env::set_var(
        "OPENSESAME_NATS_CALLOUT_ISSUERS",
        "https://identity.test,https://idp.example",
    );
    let mut state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    state.identity_mapping = Some(crate::identity_mapping::IdentityMappingClient::local_test(
        &format!("http://{}", listener.local_addr().unwrap()),
    ));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().fallback(|| async { StatusCode::NOT_FOUND }),
        )
        .await
        .unwrap();
    });
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/nats/auth/callout")
        .header("content-type", "application/json")
        .header("x-opensesame-callout-token", "callout-http-test")
        .body(Body::from(
            serde_json::json!({
                "issuer": "https://identity.test",
                "subject": "oidc-sub-http",
                "project_ids": ["proj_a"],
            })
            .to_string(),
        ))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    server.abort();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["decision"], "deny");
    assert_eq!(body["error"], "unmapped_principal");

    // Mapped principal path via decide (unit); HTTP unmapped above is enough for deny.
    let cfg = test_cfg();
    let allow = decide_nats_callout(
        &cfg,
        NatsCalloutRequest {
            issuer: "https://identity.test".into(),
            subject: "sub-mapped".into(),
            user_nkey: String::new(),
            server_id: String::new(),
            email: None,
            join_by_email: false,
            project_ids: vec!["proj_a".into()],
            token_claims: None,
        },
        Some(MappedPrincipal {
            principal_id: "prn_http".into(),
            provisional: false,
            assurance: "verified".into(),
            issuer: "https://identity.test".into(),
            subject: "sub-mapped".into(),
        }),
    );
    assert_eq!(allow.decision, "allow");
    let perms = allow.permissions.expect("permissions");
    assert!(!permissions_include_system(&perms));
    assert!(
        !perms
            .subscribe
            .iter()
            .chain(perms.publish.iter())
            .any(|s| s.contains("proj_a")),
        "self-asserted project_ids must not grant project event subjects"
    );

    match prev_secret {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
    }
    match prev_issuers {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_ISSUERS", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_ISSUERS"),
    }
}

#[tokio::test]
async fn http_callout_rejects_bad_token() {
    let _guard = env_lock();
    use crate::app_state;
    use crate::config::Args;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
    std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret");
    let state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/nats/auth/callout")
        .header("content-type", "application/json")
        .header("x-opensesame-callout-token", "wrong-secret")
        .body(Body::from(
            r#"{"issuer":"https://identity.test","subject":"s1"}"#,
        ))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    match prev {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
    }
}

#[tokio::test]
async fn http_callout_missing_token_fails_closed() {
    let _guard = env_lock();
    use crate::app_state;
    use crate::config::Args;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    let prev = std::env::var_os("OPENSESAME_NATS_CALLOUT_SECRET");
    std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", "good-secret");
    let state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/nats/auth/callout")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"issuer":"https://identity.test","subject":"s1"}"#,
        ))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["decision"], "deny");
    assert_eq!(json["error"], "unauthorized");
    let text = json.to_string();
    assert!(!text.contains("good-secret"));
    assert!(!text.contains("access_token"));
    match prev {
        Some(v) => std::env::set_var("OPENSESAME_NATS_CALLOUT_SECRET", v),
        None => std::env::remove_var("OPENSESAME_NATS_CALLOUT_SECRET"),
    }
}

#[tokio::test]
async fn mapping_partition_denies_rather_than_allowing() {
    let cfg = test_cfg();
    for n in 0..32 {
        let resp = decide_nats_callout(
            &cfg,
            NatsCalloutRequest {
                issuer: "https://identity.test".into(),
                subject: format!("sub-{n}"),
                user_nkey: "UTEST".into(),
                server_id: "NTEST".into(),
                email: None,
                join_by_email: false,
                project_ids: vec![format!("proj_{n}")],
                token_claims: None,
            },
            None,
        );
        assert_eq!(resp.decision, "deny");
        assert_eq!(resp.error, Some("unmapped_principal"));
        assert!(resp.permissions.is_none());
        let wire = serde_json::to_value(&resp).unwrap();
        assert!(wire.get("shared_secret").is_none());
        assert!(wire.get("access_token").is_none());
        assert!(wire.get("email").is_none());
    }
}
