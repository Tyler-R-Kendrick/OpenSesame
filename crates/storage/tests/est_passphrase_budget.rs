//! Password verification reservations survive process-local state and races.
mod support;

use opensesame_storage::{Db, StoredEstConfig};
use support::{seed_org, NOW, ORG_ONE, ORG_TWO};

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
            db.admit_est_passphrase_attempt(ORG_ONE, &config.id, 1000)
                .await
                .unwrap(),
            Some(attempt)
        );
    }
    assert!(db.update_est_config(&config).await.unwrap());
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &config.id, 1599)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_TWO, &other.id, 1599)
            .await
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        db.admit_est_passphrase_attempt(ORG_ONE, &config.id, 1600)
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
            db.admit_est_passphrase_attempt(ORG_ONE, &id, 1000)
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
            .admit_est_passphrase_attempt(ORG_ONE, &config.id, 1599)
            .await
            .unwrap(),
        None
    );
    reopened.pool().close().await;
    std::fs::remove_file(path).unwrap();
}
