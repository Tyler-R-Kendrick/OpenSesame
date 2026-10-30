//! Password verification reservations survive process-local state and races.
mod support;

use opensesame_storage::{Db, StoredEstConfig};
use support::{seed_org, NOW, ORG_ONE, ORG_TWO};

const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async fn seed(db: &Db, organization: &str, suffix: &str) -> StoredEstConfig {
    let (_, _, profile_id, _) = seed_org(db, organization, suffix).await;
    let config = StoredEstConfig {
        id: format!("est:{suffix}"),
        organization_id: organization.into(),
        profile_id,
        sealed_passphrase: Some(support::sealed("bootstrap")),
        bootstrap_chain_pem: None,
        require_bootstrap: false,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    };
    db.insert_est_config(&config).await.unwrap();
    config
}

#[tokio::test]
async fn expiry_and_configuration_updates_preserve_the_budget_boundary() {
    let db = Db::connect_memory().await.unwrap();
    let config = seed(&db, ORG_ONE, "one").await;
    let other = seed(&db, ORG_TWO, "two").await;
    for attempt in 1..=5 {
        assert_eq!(
            db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1000)
                .await
                .unwrap(),
            Some(attempt)
        );
    }
    assert!(db.update_est_config(&config).await.unwrap());
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &config.id, SOURCE, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &other.id, SOURCE, 1599)
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1600)
            .await
            .unwrap(),
        Some(1)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn separate_database_clients_and_reopens_share_five_reservations() {
    let path = std::env::temp_dir().join(format!("est-budget-{}.db", uuid::Uuid::new_v4()));
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let first = Db::connect_sqlite(&url).await.unwrap();
    let config = seed(&first, ORG_ONE, "one").await;
    let second = Db::connect_sqlite(&url).await.unwrap();
    let attempts = (0..32).map(|index| {
        let db = if index % 2 == 0 {
            first.clone()
        } else {
            second.clone()
        };
        let id = config.id.clone();
        async move {
            db.admit_est_passphrase_attempt(ORG_ONE, &id, SOURCE, 1000)
                .await
                .unwrap()
        }
    });
    let results = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        futures::future::join_all(attempts),
    )
    .await
    .expect("reservations cannot deadlock");
    assert_eq!(
        results.iter().filter(|attempt| attempt.is_some()).count(),
        5
    );
    first.pool().close().await;
    second.pool().close().await;
    let reopened = Db::connect_sqlite(&url).await.unwrap();
    assert_eq!(
        reopened
            .admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1599)
            .await
            .unwrap(),
        None
    );
    reopened.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn capacity_retains_existing_clients_and_is_scoped_to_each_profile() {
    let db = Db::connect_memory().await.unwrap();
    let config = seed(&db, ORG_ONE, "one").await;
    let other = seed(&db, ORG_TWO, "two").await;
    let mut same_profile = db
        .get_certificate_profile(ORG_ONE, &config.profile_id)
        .await
        .unwrap()
        .unwrap();
    same_profile.id = "profile:same-org".into();
    same_profile.name = "other EST profile".into();
    db.insert_certificate_profile(&same_profile).await.unwrap();
    let mut same_org = config.clone();
    same_org.id = "est:same-org".into();
    same_org.profile_id = same_profile.id;
    db.insert_est_config(&same_org).await.unwrap();
    let legitimate = "b".repeat(64);
    for _ in 0..5 {
        assert!(db
            .admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1000)
            .await
            .unwrap()
            .is_some());
    }
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, &legitimate, 1000)
            .await
            .unwrap(),
        Some(1)
    );
    sqlx::query("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1021) INSERT INTO est_source_attempt_budgets SELECT ?, ?, printf('%064x', value), 1600, 1 FROM n")
        .bind(ORG_ONE).bind(&config.id).execute(db.pool()).await.unwrap();
    let admissions = (0..32).map(|index| {
        let db = db.clone();
        let id = config.id.clone();
        async move {
            db.admit_est_passphrase_attempt(ORG_ONE, &id, &format!("{:064x}", 2000 + index), 1599)
                .await
                .unwrap()
        }
    });
    assert_eq!(
        futures::future::join_all(admissions)
            .await
            .into_iter()
            .flatten()
            .count(),
        1
    );
    let newcomer = "c".repeat(64);
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, &newcomer, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, &legitimate, 1599)
            .await
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &other.id, &newcomer, 1599)
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &same_org.id, &newcomer, 1599)
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &config.id, &newcomer, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, &newcomer, 1600)
            .await
            .unwrap(),
        Some(1)
    );
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM est_source_attempt_budgets WHERE config_id = ?")
            .bind(&config.id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    // The last admitted row started at 1599 and remains live until 2199.
    assert_eq!(count, 2);
}

#[tokio::test]
async fn sources_are_independent_but_updates_and_missing_configs_never_reset_a_source() {
    let db = Db::connect_memory().await.unwrap();
    let config = seed(&db, ORG_ONE, "one").await;
    for _ in 0..5 {
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1000)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(db.update_est_config(&config).await.unwrap());
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1000)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, &"b".repeat(64), 1000)
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, "missing", SOURCE, 1000)
            .await
            .unwrap(),
        None
    );
    assert!(db.delete_est_config(ORG_ONE, &config.id).await.unwrap());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM est_source_attempt_budgets")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn invalid_tags_clock_overflow_and_storage_failure_admit_nothing() {
    let db = Db::connect_memory().await.unwrap();
    let config = seed(&db, ORG_ONE, "one").await;
    for tag in ["", "192.0.2.1", &"z".repeat(64)] {
        assert!(db
            .admit_est_passphrase_attempt(ORG_ONE, &config.id, tag, 1000)
            .await
            .is_err());
    }
    assert!(db
        .admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, i64::MAX)
        .await
        .is_err());
    sqlx::query("DROP TABLE est_source_attempt_budgets")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .admit_est_passphrase_attempt(ORG_ONE, &config.id, SOURCE, 1000)
        .await
        .is_err());
}
