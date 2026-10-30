use super::*;
use crate::budget_subject::tests::user;
use std::sync::Arc;

fn limiter(db: Db, namespace: &'static str, max: u32) -> FailureLimiter {
    FailureLimiter::new(db, namespace, max, Duration::from_secs(60))
}

#[tokio::test]
async fn checks_are_reserved_before_work_and_only_success_refunds_them() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db, "verification", 3);
    let alice = user("alice@example.test");
    let bob = user("bob@example.test");
    let subject = BudgetSubject::Account(&alice);
    for _ in 0..3 {
        assert!(fence.reserve(&subject).await.unwrap());
    }
    assert!(!fence.reserve(&subject).await.unwrap());
    assert!(fence.reserve(&BudgetSubject::Account(&bob)).await.unwrap());
    fence.clear(&subject).await.unwrap();
    assert!(fence.reserve(&subject).await.unwrap());
}

#[tokio::test]
async fn expiry_and_namespaces_are_independent() {
    let db = Db::connect_memory().await.unwrap();
    let first = limiter(db.clone(), "verification", 1);
    let request = limiter(db, "sign-in-request", 1);
    let account = user("alice@example.test");
    let subject = BudgetSubject::Account(&account);
    assert!(first.reserve_at(&subject, 1000).await.unwrap());
    assert!(!first.reserve_at(&subject, 60_999).await.unwrap());
    assert!(first.reserve_at(&subject, 61_000).await.unwrap());
    assert!(request.reserve_at(&subject, 1000).await.unwrap());
}

#[tokio::test]
async fn legacy_bucket_population_neither_evicts_lockouts_nor_blocks_known_subjects() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db.clone(), "verification", 1);
    let victim = user("victim@example.test");
    let other = user("other@example.test");
    for account in [&victim, &other] {
        assert!(db.bitwarden_create_user(account).await.unwrap());
    }
    let subject = BudgetSubject::Account(&victim);
    sqlx::query("INSERT INTO bitwarden_attempt_budgets VALUES('verification',?,61000,1)")
        .bind(FailureLimiter::bucket("account:victim@example.test"))
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
        INSERT INTO bitwarden_attempt_budgets SELECT 'verification',printf('%064x',x),61000,1 FROM n")
        .execute(db.pool()).await.unwrap();
    assert!(!fence.reserve_at(&subject, 1001).await.unwrap());
    assert!(fence
        .reserve_at(&BudgetSubject::Account(&other), 1001)
        .await
        .unwrap());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitwarden_attempt_budgets")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 10001);
    assert!(fence.reserve_at(&subject, 61000).await.unwrap());
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
    let account = Arc::new(user("victim@example.test"));
    let fences = [
        Arc::new(limiter(first.clone(), "verification", 3)),
        Arc::new(limiter(second, "verification", 3)),
    ];
    let tasks: Vec<_> = (0..32)
        .map(|index| {
            let fence = Arc::clone(&fences[index % 2]);
            let account = Arc::clone(&account);
            tokio::spawn(async move {
                fence
                    .reserve(&BudgetSubject::Account(&account))
                    .await
                    .unwrap()
            })
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
        .reserve(&BudgetSubject::Account(&account))
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
    assert!(fence
        .reserve(&BudgetSubject::Account(&user("victim@example.test")))
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_clock_ranges_never_grant_an_uncounted_guess() {
    let db = Db::connect_memory().await.unwrap();
    let fence = limiter(db.clone(), "verification", 3);
    let account = user("victim@example.test");
    let subject = BudgetSubject::Account(&account);
    assert!(fence.reserve_at(&subject, i64::MAX).await.is_err());
    let invalid = FailureLimiter::new(db, "verification", 3, Duration::MAX);
    assert!(invalid.reserve(&subject).await.is_err());
}
