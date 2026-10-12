use std::collections::BTreeMap;
use std::sync::Arc;

use crate::app_state::test_demo_state;
use crate::sync_actor::{self, SyncActorConfig};
use opensesame_connection_broker::{
    config_access::{self, PolicyActor},
    BrokerConfig, ConnectionBroker, CreateConnection, CreateSecretConfig, CreateSyncTarget,
    SyncTargetStatus,
};
use opensesame_domain::{OrganizationRole, PrincipalId};
use sqlx::Row;

#[tokio::test]
async fn background_outbox_retries_and_regrant_cannot_resurrect_revoked_authority() {
    let mut st = test_demo_state().await;
    st.connection_broker = Arc::new(
        ConnectionBroker::new(
            st.db.pool().clone(),
            BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let org = st.connection_organization;
    let principal = PrincipalId::new();
    config_access::set_role_ceiling(
        st.db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Admin),
        0,
        0,
    )
    .await
    .unwrap();
    let connection = st
        .connection_broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: "vercel".into(),
                integration_id: None,
                owner_subject: Some(principal.to_string()),
                display_name: None,
                logical_name: None,
                project_id: None,
                scopes: None,
                shareability: None,
            },
        )
        .await
        .unwrap();
    st.connection_broker
        .set_api_key(&org, &connection.connection_id, "test-only-token")
        .await
        .unwrap();
    let config = st
        .connection_broker
        .create_secret_config(
            &org.to_string(),
            CreateSecretConfig {
                project_id: "background".into(),
                slug: "development".into(),
                display_name: None,
                environment: "development".into(),
                parent_config_id: None,
            },
            None,
        )
        .await
        .unwrap();
    let target = st
        .connection_broker
        .create_sync_target_for_actor(
            &org,
            CreateSyncTarget {
                project_id: "background".into(),
                config_id: config.id.clone(),
                connection_id: connection.connection_id,
                operation: None,
            },
            &PolicyActor::Session {
                principal,
                role: OrganizationRole::Admin,
            },
        )
        .await
        .unwrap();
    // Create real dirty events, then remove the only key. Even a regression
    // can only sync an empty snapshot: this test never contacts a provider.
    let values = BTreeMap::from([("CANARY".into(), "test-only-canary".into())]);
    st.connection_broker
        .put_config_secrets(&org.to_string(), &config.id, &values, None)
        .await
        .unwrap();
    st.connection_broker
        .delete_config_secret(&org.to_string(), &config.id, "CANARY", None)
        .await
        .unwrap();
    config_access::set_role_ceiling(st.db.pool(), &org, &principal, None, 1, 0)
        .await
        .unwrap();
    let cfg = SyncActorConfig {
        backoff_base_seconds: 0,
        max_attempts: 3,
        ..SyncActorConfig::default()
    };
    for attempt in 1..=3 {
        if attempt == 3 {
            config_access::set_role_ceiling(
                st.db.pool(),
                &org,
                &principal,
                Some(OrganizationRole::Admin),
                2,
                0,
            )
            .await
            .unwrap();
        }
        sync_actor::pass(&st, &cfg).await.unwrap();
        let current = st.connection_broker.get_sync_target(&org, &target.id).await.unwrap();
        assert_eq!(current.status, SyncTargetStatus::Idle);
        assert!(current.last_synced_at.is_none());
        let rows = sqlx::query(
            "SELECT attempts,published_at,dead_lettered_at,last_error
             FROM config_sync_outbox WHERE config_id=?",
        )
        .bind(&config.id)
        .fetch_all(st.db.pool())
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.get::<i64, _>("attempts"), attempt);
            assert!(row.get::<Option<String>, _>("published_at").is_none());
            assert_eq!(row.get::<Option<String>, _>("dead_lettered_at").is_some(), attempt == 3);
            let reason = row.get::<Option<String>, _>("last_error").unwrap();
            assert!(reason.contains("sync target not found"), "{reason}");
            assert!(!reason.contains("test-only"));
        }
        sqlx::query(
            "UPDATE config_sync_outbox SET available_at=NULL
             WHERE published_at IS NULL AND dead_lettered_at IS NULL",
        )
        .execute(st.db.pool())
        .await
        .unwrap();
    }
}
