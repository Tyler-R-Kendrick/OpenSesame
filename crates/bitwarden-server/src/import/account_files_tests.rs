use axum::{routing::get, Json, Router};
use opensesame_provider_bitwarden::{DeviceIdentity, Endpoints};

use super::*;

const ENC: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAA";

#[tokio::test]
async fn attachment_ids_cannot_choose_paths_or_overwrite_prior_downloads() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = format!("{base}/download");
    let router = Router::new()
        .route("/download", get(|| async { "downloaded ciphertext" }))
        .fallback(get(move || {
            let url = url.clone();
            async move { Json(json!({"url": url})) }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let api = Client::new(
        Endpoints::from_server_url(&base).unwrap(),
        DeviceIdentity::new("import-path-test"),
    )
    .unwrap();
    let work = tempfile::tempdir().unwrap();
    let scratch = work.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    let sentinel = work.path().join("outside");
    std::fs::write(&sentinel, b"unchanged").unwrap();
    let user = crate::import::tests::user();
    for id in [
        "../outside",
        "..\\outside",
        "/outside",
        "C:\\outside",
        "%2e%2e%2foutside",
    ] {
        let attachment = json!({"id": id, "fileName": ENC});
        assert!(fetch(&api, "token", "cipher", &attachment, &user, &scratch)
            .await
            .is_none());
    }
    let absolute = json!({"id": sentinel.to_str().unwrap(), "fileName": ENC});
    assert!(fetch(&api, "token", "cipher", &absolute, &user, &scratch)
        .await
        .is_none());
    let good = json!({"id": "file-id", "fileName": ENC});
    assert!(fetch(&api, "token", "../cipher", &good, &user, &scratch)
        .await
        .is_none());
    let one = fetch(&api, "token", "cipher", &good, &user, &scratch)
        .await
        .unwrap();
    let two = fetch(&api, "token", "cipher", &good, &user, &scratch)
        .await
        .unwrap();
    let (FileSource::Disk(first), FileSource::Disk(second)) = (one.source, two.source) else {
        unreachable!();
    };
    assert_ne!(first, second);
    assert!(first.starts_with(&scratch) && second.starts_with(&scratch));
    assert_eq!(std::fs::read(first).unwrap(), b"downloaded ciphertext");
    assert_eq!(std::fs::read(second).unwrap(), b"downloaded ciphertext");
    assert_eq!(std::fs::read(sentinel).unwrap(), b"unchanged");
    server.abort();
}
