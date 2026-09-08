use opensesame_storage::{callback_replay::CallbackClaim, Db};

#[tokio::test]
async fn callback_claim_is_single_winner_and_survives_restart() {
    let path =
        std::env::temp_dir().join(format!("callback-replay-{}.sqlite", uuid::Uuid::new_v4()));
    let url = format!("sqlite://{}", path.display());
    std::fs::File::create_new(&path).unwrap();
    let first = Db::connect_sqlite(&url).await.unwrap();
    first.migrate().await.unwrap();
    let second = Db::connect_sqlite(&url).await.unwrap();
    let digest = "a".repeat(64);
    let (a, b) = tokio::join!(
        first.claim_callback_delivery("conn", "delivery", &digest, 1000),
        second.claim_callback_delivery("conn", "delivery", &digest, 1000)
    );
    assert!(matches!(
        (a.unwrap(), b.unwrap()),
        (CallbackClaim::New, CallbackClaim::Duplicate)
            | (CallbackClaim::Duplicate, CallbackClaim::New)
    ));
    drop(first);
    drop(second);
    let restarted = Db::connect_sqlite(&url).await.unwrap();
    assert_eq!(
        restarted
            .claim_callback_delivery("conn", "delivery", &digest, 1100)
            .await
            .unwrap(),
        CallbackClaim::Duplicate
    );
    assert_eq!(
        restarted
            .claim_callback_delivery("conn", "delivery", &"b".repeat(64), 1100)
            .await
            .unwrap(),
        CallbackClaim::Mismatch
    );
    assert_eq!(
        restarted
            .claim_callback_delivery("conn", "delivery", &digest, 1601)
            .await
            .unwrap(),
        CallbackClaim::New
    );
    drop(restarted);
    std::fs::remove_file(path).unwrap();
}
