//! Minting against a connection, including after revocation.

use super::*;

#[tokio::test]
async fn minting_against_a_revoked_connection_fails() {
    let Some(pem) = mint_test_rsa_pem() else {
        eprintln!("skipping: openssl unavailable");
        return;
    };
    let api_base = github_api_server().await;
    let (_db, broker, organization, integration_id) = github_app_broker(&api_base, &pem).await;
    let connection = broker
        .create_connection(
            &organization,
            CreateConnection {
                integration_id: Some(integration_id),
                owner_subject: Some("user:alice".into()),
                ..create("github")
            },
        )
        .await
        .unwrap();
    broker
        .update_policy(
            &organization,
            &connection.connection_id,
            Shareability::Private,
            2,
            Some(MaterializationPolicy::DerivedShortLived),
        )
        .await
        .unwrap();
    broker
        .revoke(&organization, &connection.connection_id)
        .await
        .unwrap();
    let error = broker
        .mint_derived_token(
            &organization,
            &connection.connection_id,
            "user:alice",
            Some("777"),
        )
        .await
        .unwrap_err();
    // Policy is erased by revocation along with the credential; either way the
    // mint must not happen.
    assert!(matches!(
        error.code(),
        "materialization_denied" | "invalid_request"
    ));
}

// ---- project-config secret store (ADR 0052) --------------------------------

mod secret_config_store {
    use super::*;
    use crate::store::{
        claim_config_sync_batch, dead_letter_config_sync, delete_config_value,
        delete_secret_config, get_config_value_version_sealed, get_secret_config,
        insert_secret_config, list_config_key_meta, list_config_value_versions,
        list_secret_configs, load_config_values_sealed, mark_config_sync_published,
        park_config_sync, upsert_config_value, SecretConfigRow, UpsertConfigValue,
    };
    use chrono::Utc;

    const ORG: &str = "org_test";
    const PROJECT: &str = "proj_test";
    const CONFIG: &str = "cfg_dev";

    fn config_row(id: &str, slug: &str, environment: &str) -> SecretConfigRow {
        SecretConfigRow {
            id: id.into(),
            organization_id: ORG.into(),
            project_id: PROJECT.into(),
            slug: slug.into(),
            display_name: slug.to_uppercase(),
            environment: environment.into(),
            parent_config_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    async fn seeded_pool() -> sqlx::SqlitePool {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        insert_secret_config(&pool, &config_row(CONFIG, "development", "development"))
            .await
            .expect("insert config");
        pool
    }

    fn upsert<'a>(key_name: &'a str, plaintext: &'a [u8]) -> UpsertConfigValue<'a> {
        UpsertConfigValue {
            organization_id: ORG,
            project_id: PROJECT,
            config_id: CONFIG,
            key_name,
            plaintext,
            actor_id: Some("operator:test"),
        }
    }

    #[tokio::test]
    async fn config_crud_roundtrip() {
        let pool = seeded_pool().await;
        let found = get_secret_config(&pool, ORG, CONFIG)
            .await
            .expect("get")
            .expect("some");
        assert_eq!(found.slug, "development");
        assert_eq!(found.environment, "development");
        let listed = list_secret_configs(&pool, ORG, PROJECT)
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        // Another org sees nothing.
        assert!(get_secret_config(&pool, "org_other", CONFIG)
            .await
            .expect("get")
            .is_none());
        assert!(delete_secret_config(&pool, ORG, CONFIG).await.expect("del"));
        assert!(!delete_secret_config(&pool, ORG, CONFIG).await.expect("del"));
    }

    #[tokio::test]
    async fn an_invalid_environment_is_refused() {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        let error = insert_secret_config(&pool, &config_row("cfg_bad", "bad", "prod"))
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "invalid_request");
    }

    #[tokio::test]
    async fn upsert_bumps_versions_and_seals_per_version() {
        let pool = seeded_pool().await;
        let v1 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"first"))
            .await
            .expect("v1");
        let v2 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"second"))
            .await
            .expect("v2");
        assert_eq!((v1, v2), (1, 2));

        let meta = list_config_key_meta(&pool, ORG, CONFIG)
            .await
            .expect("meta");
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].key_name, "API_KEY");
        assert_eq!(meta[0].version, 2);

        // Head opens under the v2 AAD, and only the v2 AAD.
        let sealed = load_config_values_sealed(&pool, ORG, CONFIG)
            .await
            .expect("sealed");
        assert_eq!(sealed.len(), 1);
        let ad_v2 = crate::crypto::config_value_ad(ORG, PROJECT, CONFIG, "API_KEY", 2);
        assert_eq!(
            crate::crypto::open_with_ad(&KEY, &ad_v2, &sealed[0].sealed).expect("open"),
            b"second"
        );
        let ad_v1 = crate::crypto::config_value_ad(ORG, PROJECT, CONFIG, "API_KEY", 1);
        assert!(crate::crypto::open_with_ad(&KEY, &ad_v1, &sealed[0].sealed).is_err());

        // The v1 row is still retrievable and opens under its own AAD.
        let old = get_config_value_version_sealed(&pool, ORG, CONFIG, "API_KEY", 1)
            .await
            .expect("query")
            .expect("v1 kept");
        assert_eq!(
            crate::crypto::open_with_ad(&KEY, &ad_v1, &old.sealed).expect("open v1"),
            b"first"
        );
    }

    #[tokio::test]
    async fn upsert_against_a_missing_config_is_refused() {
        let db = Db::connect_memory().await.expect("db");
        let pool = db.pool().clone();
        let error = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"x"))
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "config_not_found");
    }

    #[tokio::test]
    async fn delete_tombstones_and_versions_stay_monotonic() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("API_KEY", b"first"))
            .await
            .expect("v1");
        assert!(delete_config_value(&pool, ORG, CONFIG, "API_KEY", None)
            .await
            .expect("delete"));
        assert!(list_config_key_meta(&pool, ORG, CONFIG)
            .await
            .expect("meta")
            .is_empty());
        let versions = list_config_value_versions(&pool, ORG, CONFIG, "API_KEY")
            .await
            .expect("versions");
        assert_eq!(versions.len(), 2);
        assert!(versions[0].deleted);
        // A deleted version slot is not retrievable as a value.
        assert!(
            get_config_value_version_sealed(&pool, ORG, CONFIG, "API_KEY", 2)
                .await
                .expect("query")
                .is_none()
        );
        // Re-inserting continues after the tombstone: no version reuse.
        let v3 = upsert_config_value(&pool, &KEY, upsert("API_KEY", b"third"))
            .await
            .expect("v3");
        assert_eq!(v3, 3);
    }

    #[tokio::test]
    async fn mutations_append_sync_wakes_and_backup_events_atomically() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("API_KEY", b"sw0rdf1sh-plaintext"))
            .await
            .expect("upsert");

        let claimed = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].event_type, "sync.config.dirty");
        assert_eq!(claimed[0].config_id, CONFIG);
        // The lease holds: a second claim sees nothing.
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());

        // The backup outbox got its own event in the same transaction, and the
        // payload carries names only — never a value.
        let backup: Vec<String> =
            sqlx::query_scalar("SELECT payload_json FROM outbox_events ORDER BY created_at")
                .fetch_all(&pool)
                .await
                .expect("outbox");
        assert!(!backup.is_empty());
        assert!(backup
            .iter()
            .all(|payload| !payload.contains("sw0rdf1sh-plaintext")));
    }

    #[tokio::test]
    async fn park_and_dead_letter_shape_the_sync_queue() {
        let pool = seeded_pool().await;
        upsert_config_value(&pool, &KEY, upsert("A", b"1"))
            .await
            .expect("upsert");
        let first = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        let ids: Vec<String> = first.iter().map(|e| e.id.clone()).collect();

        // Parked with zero backoff → claimable again, attempts grew.
        park_config_sync(&pool, &ids, "provider 503", 0)
            .await
            .expect("park");
        let again = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        assert_eq!(again.len(), 1);
        assert!(again[0].attempts >= 2);

        dead_letter_config_sync(&pool, &ids, "gave up")
            .await
            .expect("dead");
        park_config_sync(&pool, &ids, "should not resurrect", 0)
            .await
            .expect("park");
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());

        // Published rows never come back either.
        upsert_config_value(&pool, &KEY, upsert("B", b"2"))
            .await
            .expect("upsert");
        let fresh = claim_config_sync_batch(&pool, 10, 60).await.expect("claim");
        let fresh_ids: Vec<String> = fresh.iter().map(|e| e.id.clone()).collect();
        mark_config_sync_published(&pool, &fresh_ids)
            .await
            .expect("publish");
        park_config_sync(&pool, &fresh_ids, "no-op", 0)
            .await
            .expect("park");
        assert!(claim_config_sync_batch(&pool, 10, 60)
            .await
            .expect("claim")
            .is_empty());
    }
}

mod secret_config_domain {
    use super::*;
    use crate::secret_config::{CreateSecretConfig, StoreSecretSource};
    use std::collections::BTreeMap;

    async fn broker_and_pool() -> (Db, ConnectionBroker) {
        broker().await
    }

    fn create(project: &str, slug: &str, environment: &str) -> CreateSecretConfig {
        CreateSecretConfig {
            project_id: project.into(),
            slug: slug.into(),
            display_name: None,
            environment: environment.into(),
            parent_config_id: None,
        }
    }

    fn secrets(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|&(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    const ORG: &str = "org_domain";

    #[tokio::test]
    async fn config_lifecycle_with_changelog() {
        let (_db, broker) = broker_and_pool().await;
        clear_secret_changelog_for_tests();
        let view = broker
            .create_secret_config(
                ORG,
                create("proj", "development", "development"),
                Some("op"),
            )
            .await
            .expect("create");
        assert_eq!(view.slug, "development");

        broker
            .put_config_secrets(
                ORG,
                &view.id,
                &secrets(&[("API_KEY", "v-secret")]),
                Some("op"),
            )
            .await
            .expect("put");
        let meta = broker.config_key_meta(ORG, &view.id).await.expect("meta");
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].version, 1);

        let entries = list_secret_changelog(ORG, "proj", 10);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event_type.as_str()).collect();
        assert!(kinds.contains(&"secret.config.created"));
        assert!(kinds.contains(&"secret.value.changed"));
        // Changelog never carries the value.
        for entry in &entries {
            let text = serde_json::to_string(entry).expect("json");
            assert!(!text.contains("v-secret"));
        }

        broker
            .delete_config_secret(ORG, &view.id, "API_KEY", Some("op"))
            .await
            .expect("delete value");
        broker
            .delete_secret_config(ORG, &view.id, Some("op"))
            .await
            .expect("delete config");
    }

    #[tokio::test]
    async fn invalid_key_names_and_oversized_values_are_refused() {
        let (_db, broker) = broker_and_pool().await;
        let view = broker
            .create_secret_config(ORG, create("proj", "dev-a", "development"), None)
            .await
            .expect("create");
        let bad = broker
            .put_config_secrets(ORG, &view.id, &secrets(&[("has-dash", "x")]), None)
            .await
            .expect_err("bad key");
        assert_eq!(bad.code(), "invalid_request");
        let huge = "x".repeat(crate::MAX_CREDENTIAL_BYTES + 1);
        let big = broker
            .put_config_secrets(ORG, &view.id, &secrets(&[("OK_KEY", huge.as_str())]), None)
            .await
            .expect_err("oversized");
        assert_eq!(big.code(), "invalid_request");
    }

    #[tokio::test]
    async fn store_source_resolves_inheritance_and_references() {
        let (db, broker) = broker_and_pool().await;
        let root = broker
            .create_secret_config(ORG, create("proj", "base", "development"), None)
            .await
            .expect("root");
        let mut child_spec = create("proj", "branch-a", "development");
        child_spec.parent_config_id = Some(root.id.clone());
        let child = broker
            .create_secret_config(ORG, child_spec, None)
            .await
            .expect("child");

        broker
            .put_config_secrets(
                ORG,
                &root.id,
                &secrets(&[
                    ("HOST", "db.example"),
                    ("PORT", "5432"),
                    ("USER", "root-user"),
                ]),
                None,
            )
            .await
            .expect("root put");
        broker
            .put_config_secrets(
                ORG,
                &child.id,
                &secrets(&[
                    ("USER", "child-user"),
                    ("URL", "postgres://${USER}@${HOST}:${PORT}/app"),
                    ("LITERAL", "keep $${THIS} verbatim"),
                ]),
                None,
            )
            .await
            .expect("child put");

        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let resolved = source
            .load_config_secrets(ORG, "proj", &child.id)
            .await
            .expect("resolve");
        assert_eq!(resolved["HOST"], "db.example");
        assert_eq!(resolved["USER"], "child-user"); // child overrides parent
        assert_eq!(resolved["URL"], "postgres://child-user@db.example:5432/app");
        assert_eq!(resolved["LITERAL"], "keep ${THIS} verbatim");
    }

    #[tokio::test]
    async fn reference_cycles_and_missing_refs_fail_closed() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "cyclic", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(
                ORG,
                &cfg.id,
                &secrets(&[("A", "${B}"), ("B", "${A}"), ("LONER", "${MISSING}")]),
                None,
            )
            .await
            .expect("put");
        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let error = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect_err("must fail");
        assert_eq!(error.code(), "invalid_request");
    }

    #[tokio::test]
    async fn production_values_cannot_be_referenced_from_dev() {
        let (_db, broker) = broker_and_pool().await;
        let prod = broker
            .create_secret_config(ORG, create("proj", "prod", "production"), None)
            .await
            .expect("prod");
        broker
            .put_config_secrets(ORG, &prod.id, &secrets(&[("DB_URL", "prod-only")]), None)
            .await
            .expect("prod put");
        let dev = broker
            .create_secret_config(ORG, create("proj", "dev", "development"), None)
            .await
            .expect("dev");
        // Refused at write time.
        let error = broker
            .put_config_secrets(
                ORG,
                &dev.id,
                &secrets(&[("LEAK", "${config:prod.DB_URL}")]),
                None,
            )
            .await
            .expect_err("must refuse");
        assert_eq!(error.code(), "invalid_request");
        // Prod may reference prod.
        broker
            .put_config_secrets(
                ORG,
                &prod.id,
                &secrets(&[("MIRROR", "${config:prod.DB_URL}")]),
                None,
            )
            .await
            .expect("prod self-reference allowed");
    }

    #[tokio::test]
    async fn rollback_reseal_produces_a_new_head_version() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "rollme", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "one")]), None)
            .await
            .expect("v1");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "two")]), None)
            .await
            .expect("v2");
        let new_head = broker
            .rollback_config_secret(ORG, &cfg.id, "K", 1, Some("op"))
            .await
            .expect("rollback");
        assert_eq!(new_head, 3);
        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let resolved = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect("resolve");
        assert_eq!(resolved["K"], "one");
        // Rolling back to a version that never existed is refused.
        let missing = broker
            .rollback_config_secret(ORG, &cfg.id, "K", 99, None)
            .await
            .expect_err("no such version");
        assert_eq!(missing.code(), "config_value_not_found");
    }

    #[tokio::test]
    async fn negative_stored_version_fails_closed_before_aad_open() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "negative-version", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "value")]), None)
            .await
            .expect("put");
        sqlx::query(
            "UPDATE config_secret_values SET version = -1 WHERE config_id = ? AND key_name = ?",
        )
        .bind(&cfg.id)
        .bind("K")
        .execute(db.pool())
        .await
        .expect("corrupt version fixture");

        let error = broker
            .config_key_meta(ORG, &cfg.id)
            .await
            .expect_err("negative database versions must be rejected");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("negative"));

        let source = StoreSecretSource::new(db.pool().clone(), KEY);
        let error = source
            .load_config_secrets(ORG, "proj", &cfg.id)
            .await
            .expect_err("negative version must not be cast into AAD");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("negative"));
    }

    #[tokio::test]
    async fn version_overflow_and_out_of_range_lookup_fail_without_writes() {
        let (db, broker) = broker_and_pool().await;
        let cfg = broker
            .create_secret_config(ORG, create("proj", "max-version", "development"), None)
            .await
            .expect("cfg");
        broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "value")]), None)
            .await
            .expect("put");
        sqlx::query(
            "UPDATE config_secret_values SET version = ? WHERE config_id = ? AND key_name = ?",
        )
        .bind(i64::MAX)
        .bind(&cfg.id)
        .bind("K")
        .execute(db.pool())
        .await
        .expect("max head fixture");

        let error = broker
            .put_config_secrets(ORG, &cfg.id, &secrets(&[("K", "replacement")]), None)
            .await
            .expect_err("the version counter must not wrap");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("exhausted"));
        let stored_version: i64 = sqlx::query_scalar(
            "SELECT version FROM config_secret_values WHERE config_id = ? AND key_name = ?",
        )
        .bind(&cfg.id)
        .bind("K")
        .fetch_one(db.pool())
        .await
        .expect("head version");
        assert_eq!(stored_version, i64::MAX);

        let error = broker
            .rollback_config_secret(ORG, &cfg.id, "K", u64::MAX, None)
            .await
            .expect_err("an out-of-range lookup must not alias a database version");
        assert_eq!(error.code(), "invalid_request");
        assert!(error.hint().contains("database range"));
    }

    #[tokio::test]
    async fn delete_config_refuses_while_sync_targets_reference_it() {
        let (_db, broker) = broker_and_pool().await;
        let organization = opensesame_domain::OrganizationId::new();
        let org = organization.to_string();
        let cfg = broker
            .create_secret_config(&org, create("proj", "referenced", "development"), None)
            .await
            .expect("cfg");
        // A vercel connection to hang a sync target from.
        let connection = broker
            .create_connection(
                &organization,
                CreateConnection {
                    provider_id: "vercel".into(),
                    integration_id: None,
                    display_name: Some("Vercel".into()),
                    logical_name: Some("vercel-conn".into()),
                    project_id: Some("proj".into()),
                    scopes: None,
                    shareability: None,
                    owner_subject: None,
                },
            )
            .await
            .expect("connection");
        broker
            .create_sync_target(
                &organization,
                CreateSyncTarget {
                    project_id: "proj".into(),
                    config_id: cfg.id.clone(),
                    connection_id: connection.connection_id.clone(),
                    operation: None,
                },
            )
            .await
            .expect("target");
        let refused = broker
            .delete_secret_config(&org, &cfg.id, None)
            .await
            .expect_err("must refuse");
        assert_eq!(refused.code(), "invalid_request");
    }
}

mod durable_changelog {
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
}

// ---- rotation (WP-9): machine-driven execution over the durable store -------
