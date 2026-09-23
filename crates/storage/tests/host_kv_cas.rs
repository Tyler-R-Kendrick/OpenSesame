//! `compare_and_set_host_kv`: a write lands only against the value the
//! writer read, so two writers holding the same read cannot both win.

use opensesame_storage::Db;

#[tokio::test]
async fn an_absent_key_is_claimed_once() {
    let db = Db::connect_memory().await.expect("db");
    assert!(db
        .compare_and_set_host_kv("k", None, "first")
        .await
        .expect("cas"));
    assert!(!db
        .compare_and_set_host_kv("k", None, "second")
        .await
        .expect("cas"));
    assert_eq!(
        db.get_host_kv("k").await.expect("read").as_deref(),
        Some("first")
    );
}

#[tokio::test]
async fn a_write_against_a_stale_read_is_refused() {
    let db = Db::connect_memory().await.expect("db");
    db.set_host_kv("k", "v1").await.expect("seed");
    assert!(db
        .compare_and_set_host_kv("k", Some("v1"), "v2-a")
        .await
        .expect("cas"));
    assert!(!db
        .compare_and_set_host_kv("k", Some("v1"), "v2-b")
        .await
        .expect("cas"));
    assert_eq!(
        db.get_host_kv("k").await.expect("read").as_deref(),
        Some("v2-a")
    );
}
