//! Durable secret-change changelog rows, split out of `credential_minting.rs`
//! for the module-size budget (ADR 0093).

use super::*;

#[tokio::test]
async fn changelog_rows_survive_a_new_broker_over_the_same_store() {
    let (db, broker) = broker_with(key_config()).await;
    let cfg = broker
        .create_secret_config(
            "org_durable_a",
            crate::secret_config::CreateSecretConfig {
                project_id: "proj".into(),
                slug: "development".into(),
                display_name: None,
                environment: "development".into(),
                parent_config_id: None,
            },
            Some("op"),
        )
        .await
        .expect("create");
    broker
        .put_config_secrets(
            "org_durable_a",
            &cfg.id,
            &[("API_KEY".to_string(), "v".to_string())]
                .into_iter()
                .collect(),
            Some("op"),
        )
        .await
        .expect("put");

    // A second broker over the same pool (fresh in-memory caches) still
    // sees the rows: the table, not the ring buffer, is the store.
    clear_secret_changelog_for_tests();
    let second = ConnectionBroker::new(db.pool().clone(), key_config()).expect("broker2");
    let events = second
        .list_changelog("org_durable_a", "proj", 50, None)
        .await
        .expect("list");
    let kinds: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert!(kinds.contains(&"secret.config.created"));
    assert!(kinds.contains(&"secret.value.changed"));
    assert!(events.iter().all(|e| e.seq.is_some()));
}

#[tokio::test]
async fn changelog_pages_backwards_by_seq() {
    let (_db, broker) = broker_with(key_config()).await;
    for i in 0..5 {
        broker
            .record_changelog(RecordSecretChangelog {
                event_type: "secret.value.changed".into(),
                project_id: "proj-page".into(),
                organization_id: Some("org_durable_b".into()),
                key_names: vec![format!("KEY_{i}")],
                ..Default::default()
            })
            .await
            .expect("record");
    }
    let first = broker
        .list_changelog("org_durable_b", "proj-page", 2, None)
        .await
        .expect("page1");
    assert_eq!(first.len(), 2);
    let cursor = first.iter().filter_map(|e| e.seq).min();
    let second = broker
        .list_changelog("org_durable_b", "proj-page", 2, cursor)
        .await
        .expect("page2");
    assert_eq!(second.len(), 2);
    let first_seqs: Vec<i64> = first.iter().filter_map(|e| e.seq).collect();
    let second_seqs: Vec<i64> = second.iter().filter_map(|e| e.seq).collect();
    assert!(second_seqs.iter().max() < first_seqs.iter().min());
}

#[tokio::test]
async fn unknown_event_names_record_nothing_anywhere() {
    let (db, broker) = broker_with(key_config()).await;
    crate::store::ensure_secret_changelog_schema(db.pool())
        .await
        .expect("schema");
    let error = broker
        .record_changelog(RecordSecretChangelog {
            event_type: "secret.value.exfiltrated".into(),
            project_id: "proj".into(),
            organization_id: Some("org_durable_c".into()),
            ..Default::default()
        })
        .await
        .expect_err("must refuse");
    assert_eq!(error.code(), "invalid_request");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_changelog")
        .fetch_one(db.pool())
        .await
        .expect("count");
    assert_eq!(count, 0);
    // Nothing in the cache either: fail closed means nowhere.
    assert!(list_secret_changelog("org_durable_c", "proj", 10).is_empty());
}

#[tokio::test]
async fn rollback_emits_the_frozen_rolled_back_event() {
    let (_db, broker) = broker_with(key_config()).await;
    let cfg = broker
        .create_secret_config(
            "org_durable_d",
            crate::secret_config::CreateSecretConfig {
                project_id: "proj-rb".into(),
                slug: "development".into(),
                display_name: None,
                environment: "development".into(),
                parent_config_id: None,
            },
            None,
        )
        .await
        .expect("create");
    let secrets: std::collections::BTreeMap<String, String> =
        [("K".to_string(), "one".to_string())].into_iter().collect();
    broker
        .put_config_secrets("org_durable_d", &cfg.id, &secrets, None)
        .await
        .expect("v1");
    let secrets2: std::collections::BTreeMap<String, String> =
        [("K".to_string(), "two".to_string())].into_iter().collect();
    broker
        .put_config_secrets("org_durable_d", &cfg.id, &secrets2, None)
        .await
        .expect("v2");
    broker
        .rollback_config_secret("org_durable_d", &cfg.id, "K", 1, Some("op"))
        .await
        .expect("rollback");
    let events = broker
        .list_changelog("org_durable_d", "proj-rb", 20, None)
        .await
        .expect("list");
    assert!(events
        .iter()
        .any(|e| e.event_type == "secret.value.rolled_back"));
    for event in &events {
        let text = serde_json::to_string(event).expect("json");
        assert!(!text.contains("\"one\""));
        assert!(!text.contains("\"two\""));
    }
}
