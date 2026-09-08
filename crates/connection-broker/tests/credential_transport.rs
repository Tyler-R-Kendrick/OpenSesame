use axum::{http::StatusCode, response::Redirect, routing::get, Router};
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_storage::Db;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[tokio::test]
async fn shared_credential_transport_never_follows_a_redirect() {
    let followed = Arc::new(AtomicUsize::new(0));
    let seen = followed.clone();
    let router = Router::new()
        .route(
            "/initial",
            get(|| async { Redirect::temporary("/redirected") }),
        )
        .route(
            "/redirected",
            get(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let db = Db::connect_memory().await.unwrap();
    let broker =
        ConnectionBroker::new(db.pool().clone(), BrokerConfig::in_memory(None, &base)).unwrap();
    let response = broker
        .http_client()
        .get(format!("{base}/initial"))
        .bearer_auth(uuid::Uuid::new_v4().to_string())
        .send()
        .await
        .unwrap();
    server.abort();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(followed.load(Ordering::SeqCst), 0);
}
