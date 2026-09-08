use super::*;
use axum::{routing::get, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, task)
}

fn client(base: &str) -> IdentityMappingClient {
    IdentityMappingClient::configured(base, uuid::Uuid::new_v4().simple().to_string(), true, None)
        .unwrap()
}

fn response() -> serde_json::Value {
    serde_json::json!({"principalId": format!("prn_{}", uuid::Uuid::new_v4().simple()), "provisional":false,"assurance":"verified","issuer":"https://issuer.example","subject":"subject-1"})
}

#[tokio::test]
async fn redirect_cannot_receive_mapping_credential() {
    let hits = Arc::new(AtomicUsize::new(0));
    let observed = hits.clone();
    let (target, target_task) = serve(Router::new().fallback(move || {
        let hits = observed.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            "attacker"
        }
    }))
    .await;
    let (base, task) = serve(Router::new().fallback(move || {
        let target = target.clone();
        async move { axum::response::Redirect::temporary(&target) }
    }))
    .await;
    assert!(client(&base)
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    task.abort();
    target_task.abort();
}

#[tokio::test]
async fn response_binding_and_byte_limits_are_enforced() {
    let good = response();
    let (base, task) = serve(Router::new().route(
        "/v1/principals/mapping/resolve",
        get(move || {
            let good = good.clone();
            async move { axum::Json(good) }
        }),
    ))
    .await;
    assert!(client(&base)
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .unwrap()
        .is_some());
    assert!(client(&base)
        .resolve_upstream("https://wrong.example", "subject-1")
        .await
        .is_err());
    assert!(client(&base)
        .resolve_upstream("https://issuer.example", "other")
        .await
        .is_err());
    task.abort();
    let (base, task) = serve(Router::new().fallback(|| async { "x".repeat(8193) })).await;
    assert!(client(&base)
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());
    task.abort();
}

#[tokio::test]
async fn errors_do_not_echo_provider_secrets() {
    for status in [400, 401, 403, 500] {
        let (base, task) = serve(Router::new().fallback(move || async move {
            (
                axum::http::StatusCode::from_u16(status).unwrap(),
                "sentinel-secret",
            )
        }))
        .await;
        let error = client(&base)
            .resolve_upstream("https://issuer.example", "subject-1")
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("sentinel-secret"));
        task.abort();
    }
}

#[test]
fn metadata_is_typed_and_mandatory() {
    let mut good = response();
    assert!(serde_json::from_value::<MappedPrincipal>(good.clone()).is_ok());
    let mapped: MappedPrincipal = serde_json::from_value(good.clone()).unwrap();
    assert!(validate_mapping(&mapped, "https://issuer.example", "subject-1").is_ok());
    good["extra"] = serde_json::json!({"nested":"data"});
    assert!(serde_json::from_value::<MappedPrincipal>(good).is_err());
    let mut mapped: MappedPrincipal = serde_json::from_value(response()).unwrap();
    mapped.principal_id = "user:demo".into();
    assert!(validate_mapping(&mapped, "https://issuer.example", "subject-1").is_err());
    mapped = serde_json::from_value(response()).unwrap();
    mapped.assurance = "invented".into();
    assert!(validate_mapping(&mapped, "https://issuer.example", "subject-1").is_err());
}

#[tokio::test]
async fn stalled_and_invalid_json_responses_are_bounded() {
    let (base, task) = serve(Router::new().fallback(|| async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        "late"
    }))
    .await;
    let result = tokio::time::timeout(
        Duration::from_secs(7),
        client(&base).resolve_upstream("https://issuer.example", "subject-1"),
    )
    .await;
    assert!(result.unwrap().is_err());
    task.abort();
    let (base, task) = serve(Router::new().fallback(|| async { "{invalid" })).await;
    assert!(client(&base)
        .resolve_upstream("https://issuer.example", "subject-1")
        .await
        .is_err());
    task.abort();
}
