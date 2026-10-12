use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use opensesame_connection_broker::{
    config_access::{self, PolicyActor},
    BrokerConfig, BrokerError, ConnectionBroker, CreateConnection, CreateSyncTarget,
    SyncSecretSource,
};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId, Shareability};
use opensesame_storage::Db;

struct Fixture {
    db: Db,
    broker: ConnectionBroker,
    org: OrganizationId,
    principal: PrincipalId,
    targets: Vec<String>,
    connection: String,
}

fn broker(db: &Db) -> ConnectionBroker {
    ConnectionBroker::new(
        db.pool().clone(),
        BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
    ).unwrap()
}

async fn fixture() -> Fixture {
    let db = Db::connect_memory().await.unwrap();
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='config_authorization_roles'")
        .fetch_one(db.pool()).await.unwrap();
    if exists == 0 {
        sqlx::raw_sql(include_str!("../../storage/migrations/0032_config_authorization.sql"))
            .execute(db.pool()).await.unwrap();
    }
    let broker = broker(&db);
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    config_access::set_role_ceiling(db.pool(), &org, &principal, Some(OrganizationRole::Admin), 0, 0)
        .await.unwrap();
    let actor = PolicyActor::Session { principal, role: OrganizationRole::Admin };
    let mut targets = Vec::new();
    let mut connection_id = String::new();
    for _ in 0..2 {
        let connection = broker.create_connection(&org, CreateConnection {
            provider_id: "vercel".into(),
            integration_id: None,
            owner_subject: Some(principal.to_string()),
            display_name: None,
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: Some(Shareability::Private),
        }).await.unwrap();
        broker.set_api_key(&org, &connection.connection_id, "test-only-token").await.unwrap();
        connection_id = connection.connection_id;
        let target = broker.create_sync_target_for_actor(&org, CreateSyncTarget {
            project_id: "project".into(),
            config_id: "config".into(),
            connection_id: connection_id.clone(),
            operation: None,
        }, &actor).await.unwrap();
        targets.push(target.id);
    }
    Fixture { db, broker, org, principal, targets, connection: connection_id }
}

struct CountingSource {
    calls: Arc<AtomicUsize>,
    revoke: Option<(sqlx::SqlitePool, OrganizationId, PrincipalId)>,
}

#[async_trait::async_trait]
impl SyncSecretSource for CountingSource {
    async fn load_config_secrets(
        &self, _: &str, _: &str, _: &str,
    ) -> Result<BTreeMap<String, String>, BrokerError> {
        let previous = self.calls.fetch_add(1, Ordering::SeqCst);
        if previous == 0 {
            if let Some((pool, org, principal)) = &self.revoke {
                config_access::set_role_ceiling(pool, org, principal, None, 1, 0).await.unwrap();
            }
        }
        // Never invokes a live provider, including on the positive path.
        Ok(BTreeMap::new())
    }
}

fn source(calls: &Arc<AtomicUsize>) -> Arc<dyn SyncSecretSource> {
    Arc::new(CountingSource { calls: calls.clone(), revoke: None })
}

#[tokio::test]
async fn revoked_grant_blocks_single_fanout_fingerprint_and_restarted_worker_before_loading() {
    let f = fixture().await;
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(f.broker.sync_target(&f.org, &f.targets[0], source(&calls)).await.unwrap().ok);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    config_access::set_role_ceiling(f.db.pool(), &f.org, &f.principal, None, 1, 0).await.unwrap();
    let restarted = broker(&f.db);
    assert!(restarted.sync_target(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert!(restarted.sync_all_for_config(&f.org, "config", source(&calls)).await.is_err());
    assert!(restarted.current_content_version(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1, "all denied paths must stop before secret loading");
}

#[tokio::test]
async fn legacy_target_without_a_grant_is_not_treated_as_an_operator() {
    let f = fixture().await;
    sqlx::query("DELETE FROM sync_target_authority WHERE target_id=?")
        .bind(&f.targets[0]).execute(f.db.pool()).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(f.broker.sync_target(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert!(f.broker.current_content_version(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn revocation_during_load_prevents_success_and_loading_the_next_fanout_target() {
    let f = fixture().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let secrets: Arc<dyn SyncSecretSource> = Arc::new(CountingSource {
        calls: calls.clone(), revoke: Some((f.db.pool().clone(), f.org, f.principal)),
    });
    assert!(f.broker.sync_all_for_config(&f.org, "config", secrets).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    for id in &f.targets {
        let target = f.broker.get_sync_target(&f.org, id).await.unwrap();
        assert!(target.last_synced_at.is_none(), "no revoked snapshot may be marked synced");
        assert!(target.content_version.is_none());
    }
}

#[tokio::test]
async fn restoring_a_role_does_not_resurrect_an_old_background_delegation() {
    let f = fixture().await;
    config_access::set_role_ceiling(f.db.pool(), &f.org, &f.principal, None, 1, 0).await.unwrap();
    config_access::set_role_ceiling(f.db.pool(), &f.org, &f.principal, Some(OrganizationRole::Admin), 2, 0)
        .await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(f.broker.sync_target(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn missing_member_and_cross_organization_authority_cannot_create_a_delegation() {
    let f = fixture().await;
    let member = PrincipalId::new();
    config_access::set_role_ceiling(f.db.pool(), &f.org, &member, Some(OrganizationRole::Member), 0, 0)
        .await.unwrap();
    for (org, principal) in [
        (f.org, PrincipalId::new()),
        (f.org, member),
        (OrganizationId::new(), f.principal),
    ] {
        let result = f.broker.create_sync_target_for_actor(&org, CreateSyncTarget {
            project_id: "project".into(), config_id: "config".into(),
            connection_id: f.connection.clone(), operation: None,
        }, &PolicyActor::Session { principal, role: OrganizationRole::Owner }).await;
        assert!(matches!(result, Err(BrokerError::SyncTargetNotFound)));
    }
}

#[tokio::test]
async fn policy_database_failure_stops_before_the_secret_loader() {
    let f = fixture().await;
    sqlx::query("DROP TABLE config_project_access").execute(f.db.pool()).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(f.broker.sync_target(&f.org, &f.targets[0], source(&calls)).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn native_operator_creation_remains_explicit_and_delete_removes_the_grant() {
    let f = fixture().await;
    let target = f.broker.create_sync_target(&f.org, CreateSyncTarget {
        project_id: "native".into(), config_id: "native-config".into(),
        connection_id: f.connection.clone(), operation: None,
    }).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    assert!(f.broker.sync_target(&f.org, &target.id, source(&calls)).await.unwrap().ok);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.broker.delete_sync_target(&f.org, &target.id).await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_target_authority WHERE target_id=?")
        .bind(&target.id).fetch_one(f.db.pool()).await.unwrap();
    assert_eq!(remaining, 0);
}
