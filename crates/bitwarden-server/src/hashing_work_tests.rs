use super::*;
use crate::budget_subject::tests::user;
use crate::hashing::HashRegistry;
use crate::ServerConfig;
use axum::body::Body;
use axum::http::Request;
use opensesame_storage::Db;
use tower::ServiceExt as _;

async fn server() -> BitwardenServer {
    let mut config = ServerConfig::new("http://localhost");
    config.hash_concurrency = 1;
    config.hash_queue = 0;
    BitwardenServer::new(
        Db::connect_memory().await.unwrap(),
        config,
        HashRegistry::default(),
        None,
    )
}

#[tokio::test]
async fn a_full_hash_queue_refuses_before_any_known_or_unknown_budget_is_allocated() {
    let server = server().await;
    let mut account = user("known@example.test");
    account.master_password_hash = server.hash_secret("registered-secret").await.unwrap();
    assert!(server.db.bitwarden_create_user(&account).await.unwrap());
    let admission = server.hash_slot().await.unwrap();
    for email in ["known@example.test", "unknown@example.test"] {
        let form = format!(
            "grant_type=password&username={email}&password=wrong&client_id=web&deviceIdentifier=d"
        );
        let response = server
            .clone()
            .router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/identity/connect/token")
                    .header("content-type", "application/x-www-form-urlencoded")
                    .body(Body::from(form))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 429);
        let response = server.clone().router().oneshot(Request::builder().method("POST")
            .uri("/api/two-factor/recover").header("content-type","application/json")
            .body(Body::from(serde_json::json!({"email":email,"masterPasswordHash":"wrong","recoveryCode":"wrong"}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), 429);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitwarden_attempt_budgets")
        .fetch_one(server.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    drop(admission);
    assert!(server.hash_slot().await.is_ok());
}

#[tokio::test]
async fn decoy_initialization_reuses_its_only_admitted_hash_slot() {
    let server = server().await;
    let admission = server.hash_slot().await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        server.decoy_check_admitted(&admission, "wrong"),
    )
    .await
    .unwrap()
    .unwrap();
    drop(admission);
    assert!(server.hash_slot().await.is_ok());
}

#[tokio::test]
async fn cancelling_a_request_cannot_release_its_running_blocking_hash() {
    let server = server().await;
    let owned = server.clone();
    let (started, began) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let request = tokio::spawn(async move {
        let admission = owned.hash_slot().await.unwrap();
        blocking(&admission, move || {
            let _ = started.send(());
            wait.recv().unwrap();
        })
        .await
        .unwrap();
    });
    began.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let rejected = server.hash_slot().await.is_err();
    release.send(()).unwrap();
    let returned = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        server.hash_admission.acquire(),
    )
    .await
    .unwrap()
    .unwrap();
    drop(returned);
    assert!(rejected);
    assert!(server.hash_slot().await.is_ok());
}
