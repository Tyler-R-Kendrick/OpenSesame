use super::*;
use std::sync::Arc;

fn limiter(db: Db, namespace: &'static str, max: u32) -> FailureLimiter {
    FailureLimiter::new(db, namespace, max, Duration::from_secs(60))
}

#[tokio::test]
async fn checks_are_reserved_before_work_and_only_success_refunds_them() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db, "verification", 3);
    for _ in 0..3 {
        assert!(fence.reserve("account:a@example.com").await.unwrap());
    }
    assert!(!fence.reserve("account:a@example.com").await.unwrap());
    assert!(fence.reserve("account:b@example.com").await.unwrap());
    fence.clear("account:a@example.com").await.unwrap();
    assert!(fence.reserve("account:a@example.com").await.unwrap());
}

#[tokio::test]
async fn expiry_and_namespaces_are_independent() {
    let db = Db::connect_memory().await.unwrap();
    let first = limiter(db.clone(), "verification", 1);
    let request = limiter(db, "sign-in-request", 1);
    assert!(first.reserve_at("same", 1000).await.unwrap());
    assert!(!first.reserve_at("same", 60_999).await.unwrap());
    assert!(first.reserve_at("same", 61_000).await.unwrap());
    assert!(request.reserve_at("same", 1000).await.unwrap());
}

#[tokio::test]
async fn capacity_never_evicts_a_live_lockout() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db.clone(), "verification", 1);
    assert!(fence.reserve_at("victim", 1000).await.unwrap());
    sqlx::query(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 9999)
         INSERT INTO bitwarden_attempt_budgets(namespace,bucket,expires_at,attempts)
         SELECT 'verification', printf('%064x',x), 61000, 1 FROM n",
    )
    .execute(db.pool())
    .await
    .unwrap();
    assert!(!fence.reserve_at("new attacker id", 1001).await.unwrap());
    assert!(!fence.reserve_at("victim", 1001).await.unwrap());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitwarden_attempt_budgets")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, CAPACITY);
    // Expired rows, unlike live rows, do release capacity.
    assert!(fence.reserve_at("new legitimate id", 61000).await.unwrap());
}

#[tokio::test]
async fn parallel_instances_and_a_restart_share_one_budget() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("limits.db").display()
    );
    let first = Db::connect_sqlite(&url).await.unwrap();
    let second = Db::connect_sqlite(&url).await.unwrap();
    let fences = [
        Arc::new(limiter(first.clone(), "verification", 3)),
        Arc::new(limiter(second, "verification", 3)),
    ];
    let tasks: Vec<_> = (0..32)
        .map(|index| {
            let fence = Arc::clone(&fences[index % 2]);
            tokio::spawn(async move { fence.reserve("victim").await.unwrap() })
        })
        .collect();
    let mut admitted = 0;
    for task in tasks {
        if task.await.unwrap() {
            admitted += 1;
        }
    }
    assert_eq!(admitted, 3);
    drop(fences);
    drop(first);
    let reopened = Db::connect_sqlite(&url).await.unwrap();
    assert!(!limiter(reopened, "verification", 3)
        .reserve("victim")
        .await
        .unwrap());
}

#[tokio::test]
async fn missing_storage_never_grants_an_uncounted_guess() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db.clone(), "verification", 3);
    sqlx::query("DROP TABLE bitwarden_attempt_budgets")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(fence.reserve("victim").await.is_err());
}

#[tokio::test]
async fn invalid_clock_ranges_never_grant_an_uncounted_guess() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db.clone(), "verification", 3);
    assert!(fence.reserve_at("victim", i64::MAX).await.is_err());
    let invalid = FailureLimiter::new(db, "verification", 3, Duration::MAX);
    assert!(invalid.reserve("victim").await.is_err());
}
