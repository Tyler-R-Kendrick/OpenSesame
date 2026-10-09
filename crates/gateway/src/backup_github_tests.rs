use super::*;

#[tokio::test]
async fn response_json_rejects_oversize_and_invalid_success_without_echoing() {
    let response = axum::http::Response::builder()
        .status(200)
        .body("x".repeat(1024 * 1024 + 1))
        .unwrap();
    assert!(response_json(response.into()).await.is_err());
    let response = axum::http::Response::builder()
        .status(200)
        .body("secret-shaped upstream response")
        .unwrap();
    let Err(StepError::Retry(error)) = response_json(response.into()).await else {
        panic!("invalid JSON accepted")
    };
    assert_eq!(error, "invalid Git response");
    let response = axum::http::Response::builder()
        .status(403)
        .body("provider secret echo")
        .unwrap();
    let Ok((status, body)) = response_json(response.into()).await else {
        panic!("bounded refusal response failed")
    };
    assert_eq!(status, 403);
    assert!(body.is_null());
}

#[test]
fn object_ids_are_exact_supported_hashes_not_paths_or_unbounded_strings() {
    for value in ["a".repeat(40), "b".repeat(64)] {
        assert!(object_sha(&json!(value)).is_ok());
    }
    for value in [
        "../attacker".into(),
        "A".repeat(40),
        "x".repeat(40),
        "a".repeat(41),
        String::new(),
    ] {
        assert!(object_sha(&json!(value)).is_err());
    }
}

#[tokio::test]
async fn malformed_head_is_refused_before_any_following_git_request() {
    use axum::{routing::get, Json, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let observed = calls.clone();
    let router = Router::new()
        .route(
            "/repos/owner/repo/git/ref/heads/main",
            get(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Json(json!({"object":{"sha":"../attacker"}}))
                }
            }),
        )
        .fallback(move || {
            let seen = calls.clone();
            async move {
                seen.fetch_add(100, Ordering::SeqCst);
                Json(json!({}))
            }
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = GithubSnapshotClient {
        http: reqwest::Client::new(),
        api_base: format!("http://{addr}"),
        token: uuid::Uuid::new_v4().to_string(),
    };
    let target = BackupTarget {
        organization_id: "org".into(),
        integration_id: String::new(),
        installation_id: String::new(),
        owner: "owner".into(),
        repo: "repo".into(),
        branch: "main".into(),
        enabled: true,
        status: "ok".into(),
        last_commit_sha: None,
        last_synced_at: None,
        last_error: None,
        kind: "github_app".into(),
        provider_id: None,
        connection_id: None,
        config: None,
    };
    let mut plan = SnapshotPlan::new(
        opensesame_storage::Db::connect_memory().await.unwrap(),
        "org".into(),
    );
    assert!(client
        .commit_snapshot(&target, &mut plan, "test")
        .await
        .is_err());
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    task.abort();
}
