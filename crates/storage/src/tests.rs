//! Storage integration tests.
//!
//! Split out of `lib.rs` under the 400-line module budget (see
//! scripts/quality-gate.mjs). `use super::*` keeps every name resolving
//! exactly as it did when this module was inline.

use super::*;
use chrono::{Duration, Utc};
use opensesame_domain::*;
use serde_json::json;

async fn apply_migration(pool: &SqlitePool, migration: &str) {
    for statement in split_statements(migration) {
        sqlx::query(&statement).execute(pool).await.unwrap();
    }
}

async fn apply_migrations(pool: &SqlitePool, migrations: &[(&str, &str)]) {
    for (_, migration) in migrations {
        apply_migration(pool, migration).await;
    }
}

async fn claim_host_kv(db: std::sync::Arc<Db>, worker: usize) -> bool {
    db.try_claim_host_kv("github.delivery.race", &format!("w{worker}"))
        .await
        .unwrap()
}

fn evidence(
    organization_id: OrganizationId,
    claimed_organization_id: Option<OrganizationId>,
    idempotency_key: &str,
) -> (Intent, Invocation, InvocationReceipt) {
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id,
        project_id: None,
        principal_id: PrincipalId::new(),
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: "https://resource.example".into(),
        normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: idempotency_key.into(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    let invocation = Invocation {
        id: InvocationId::new(),
        intent_id: intent.id,
        state: InvocationState::Succeeded,
        attempt: 1,
        lease_owner: None,
        lease_expires_at: None,
        created_at: now,
        updated_at: now,
    };
    let receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: invocation.id,
        intent_digest: "sha256:intent".into(),
        principal_id: intent.principal_id,
        organization_id: claimed_organization_id,
        actor_id: intent.actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: intent.operation.clone(),
        resource: intent.resource.clone(),
        policy_decision_id: "decision".into(),
        policy_version_digest: "sha256:policy".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: now,
        completed_at: now,
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: Some(json!({"ok": true})),
        authority_key_id: "test".into(),
        signature: "test".into(),
        receipt_schema_version: if claimed_organization_id.is_some() {
            3
        } else {
            1
        },
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    (intent, invocation, receipt)
}

fn certificate_authority(
    organization_id: &str,
    id: &str,
    is_default: bool,
) -> StoredCertificateAuthority {
    StoredCertificateAuthority {
        id: id.into(),
        organization_id: organization_id.into(),
        issuer_kind: "opensesame_private_ca".into(),
        issuer_connection_id: None,
        display_name: "OpenSesame Private CA".into(),
        public_metadata_json: r#"{"algorithm":"ES256"}"#.into(),
        sealed_material: SealedCertificateMaterial {
            key_id: "seal:v1".into(),
            ciphertext: vec![1, 2, 3],
            nonce: vec![4, 5, 6],
            aad_digest: "sha256:authority".into(),
        },
        is_default,
        status: "active".into(),
        version: 1,
        created_at: "2026-08-21T00:00:00+00:00".into(),
        updated_at: "2026-08-21T00:00:00+00:00".into(),
    }
}

fn certificate_request(
    organization_id: &str,
    authority_id: &str,
    id: &str,
    idempotency_key: &str,
) -> StoredCertificateIssuanceRequest {
    StoredCertificateIssuanceRequest {
        id: id.into(),
        organization_id: organization_id.into(),
        authority_id: authority_id.into(),
        request_digest: format!("sha256:{id}"),
        idempotency_key: idempotency_key.into(),
        created_by: "principal:owner".into(),
        state: "created".into(),
        common_name: "localhost".into(),
        san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
        delivery: None,
        expires_at: "2099-01-01T00:00:00+00:00".into(),
        version: 1,
        created_at: "2026-08-21T00:00:00+00:00".into(),
        updated_at: "2026-08-21T00:00:00+00:00".into(),
    }
}

fn issued_certificate(
    organization_id: &str,
    authority_id: &str,
    request_id: &str,
    id: &str,
) -> StoredIssuedCertificate {
    StoredIssuedCertificate {
        id: id.into(),
        organization_id: organization_id.into(),
        authority_id: authority_id.into(),
        request_id: request_id.into(),
        certificate_digest: format!("sha256:{id}"),
        serial_number: id.into(),
        common_name: "localhost".into(),
        san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
        not_before: "2026-08-21T00:00:00+00:00".into(),
        expires_at: "2026-08-22T00:00:00+00:00".into(),
        status: "active".into(),
        version: 1,
        created_at: "2026-08-21T00:00:00+00:00".into(),
        updated_at: "2026-08-21T00:00:00+00:00".into(),
    }
}

fn certificate_delivery(expires_at: &str) -> SealedCertificateDelivery {
    SealedCertificateDelivery {
        material: SealedCertificateMaterial {
            key_id: "seal:v1".into(),
            ciphertext: vec![9, 8, 7],
            nonce: vec![6, 5, 4],
            aad_digest: "sha256:delivery".into(),
        },
        expires_at: expires_at.into(),
    }
}

#[tokio::test]
async fn migrate_and_org_boundary() {
    let db = Db::connect_memory().await.unwrap();
    let org = OrganizationId::new();
    db.create_organization(&org, "acme").await.unwrap();
    assert!(db.authority_quorum_ok().await.unwrap());
    db.set_authority_quorum(false).await.unwrap();
    assert!(!db.authority_quorum_ok().await.unwrap());
}

#[tokio::test]
async fn connection_crud_is_org_scoped_and_rejects_inline_secrets() {
    let db = Db::connect_memory().await.unwrap();
    let org = OrganizationId::new();
    let now = Utc::now();
    let mut connection = ConnectionRecord {
        id: ConnectionId::new(),
        organization_id: org,
        project_id: None,
        provider_id: "aws-secrets-manager".into(),
        display_name: "production".into(),
        public_config: serde_json::json!({"region": "us-east-1"}),
        credential_ref: None,
        created_at: now,
        updated_at: now,
    };
    db.insert_connection(&connection).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM organizations WHERE id = ?")
            .bind(org.to_string())
            .fetch_one(db.pool())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        db.list_connections(&org).await.unwrap(),
        vec![connection.clone()]
    );
    connection.public_config = serde_json::json!({"api_token": "plaintext"});
    assert!(db.update_connection(&connection).await.is_err());
    assert!(db.delete_connection(&org, &connection.id).await.unwrap());
}

#[tokio::test]
async fn encrypted_sync_survives_new_db_handles_and_is_owner_scoped() {
    let db = Db::connect_memory().await.unwrap();
    let blob = StoredSyncBlob {
        id: "vault-1".into(),
        epoch: 7,
        ciphertext: vec![1, 2, 3],
    };
    assert_eq!(
        db.write_sync_blob("principal:alice", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::Accepted
    );
    assert_eq!(
        db.write_sync_blob("principal:bob", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::ForeignOwner
    );
    assert_eq!(
        db.write_sync_blob("principal:alice", &blob, 10, 5)
            .await
            .unwrap(),
        SyncWriteOutcome::StaleEpoch
    );
    assert_eq!(
        db.list_sync_blobs("principal:alice", 0).await.unwrap(),
        vec![blob]
    );
    assert!(db
        .list_sync_blobs("principal:bob", 0)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "device", 7, 1)
            .await
            .unwrap(),
        Some(7)
    );
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "another-device", 7, 1)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.advance_sync_cursor("principal:alice", "device", 9, 1)
            .await
            .unwrap(),
        Some(9)
    );
}

#[tokio::test]
async fn encrypted_sync_batch_is_atomic_on_equal_epoch_conflict() {
    let db = Db::connect_memory().await.unwrap();
    let header = StoredSyncBlob {
        id: "vault:header".into(),
        epoch: 1,
        ciphertext: vec![1],
    };
    let body = StoredSyncBlob {
        id: "vault:body".into(),
        epoch: 1,
        ciphertext: vec![2],
    };
    assert_eq!(
        db.write_sync_blobs("owner", &[header.clone(), body.clone()], 10, 10)
            .await
            .unwrap(),
        vec![SyncWriteOutcome::Accepted, SyncWriteOutcome::Accepted]
    );

    let conflicting_header = StoredSyncBlob {
        ciphertext: vec![9],
        ..header
    };
    let newer_body = StoredSyncBlob {
        epoch: 2,
        ciphertext: vec![8],
        ..body
    };
    assert_eq!(
        db.write_sync_blobs("owner", &[conflicting_header, newer_body], 10, 10)
            .await
            .unwrap(),
        vec![SyncWriteOutcome::StaleEpoch, SyncWriteOutcome::BatchAborted]
    );
    let stored = db.list_sync_blobs("owner", 0).await.unwrap();
    assert_eq!(stored.len(), 2);
    assert!(stored.iter().all(|blob| blob.epoch == 1));
    assert!(stored
        .iter()
        .any(|blob| blob.id == "vault:body" && blob.ciphertext == vec![2]));
}

#[test]
fn database_unsigned_values_reject_negative_storage() {
    assert_eq!(db_u64(0, "epoch").unwrap(), 0);
    assert_eq!(
        db_u64(i64::MAX, "epoch").unwrap(),
        u64::try_from(i64::MAX).unwrap()
    );
    assert!(db_u64(-1, "epoch").is_err());
}

#[tokio::test]
async fn sync_epoch_boundaries_fail_closed() {
    let db = Db::connect_memory().await.unwrap();
    let too_large = StoredSyncBlob {
        id: "too-large".into(),
        epoch: u64::try_from(i64::MAX).unwrap() + 1,
        ciphertext: vec![1],
    };
    assert!(db
        .write_sync_blob("owner", &too_large, 10, 10)
        .await
        .is_err());

    sqlx::query(
        "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) \
         VALUES ('corrupt', 'owner', -1, X'01', 't')",
    )
    .execute(db.pool())
    .await
    .unwrap();
    assert!(db.list_all_sync_blobs().await.is_err());
}

#[tokio::test]
async fn receipt_reads_resolve_legacy_org_and_reject_claim_mismatch() {
    let db = Db::connect_memory().await.unwrap();
    let organization_id = OrganizationId::new();
    db.create_organization(&organization_id, "acme")
        .await
        .unwrap();

    let (intent, invocation, legacy) = evidence(organization_id, None, "legacy");
    db.insert_intent(&intent).await.unwrap();
    db.insert_invocation(&invocation).await.unwrap();
    db.insert_receipt(&legacy).await.unwrap();
    let stored = db.get_receipt(&legacy.id).await.unwrap().unwrap();
    assert_eq!(stored.organization_id, organization_id);
    assert_eq!(stored.receipt.organization_id, None);
    assert_eq!(
        db.find_receipt_by_idempotency(&organization_id, "legacy")
            .await
            .unwrap()
            .unwrap()
            .organization_id,
        None
    );

    let (intent, invocation, mismatched) =
        evidence(organization_id, Some(OrganizationId::new()), "mismatch");
    db.insert_intent(&intent).await.unwrap();
    db.insert_invocation(&invocation).await.unwrap();
    db.insert_receipt(&mismatched).await.unwrap();
    assert!(db.get_receipt(&mismatched.id).await.is_err());
    assert!(db
        .find_receipt_by_idempotency(&organization_id, "mismatch")
        .await
        .is_err());
}

#[tokio::test]
async fn in_memory_database_keeps_one_migrated_schema() {
    let db = Db::connect_memory().await.unwrap();
    assert_eq!(db.pool().options().get_max_connections(), 1);
    sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
        .execute(db.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn every_migration_is_recorded_once() {
    let db = Db::connect_memory().await.unwrap();
    let applied = db.applied_migrations().await.unwrap();
    assert_eq!(
        applied,
        MIGRATIONS
            .iter()
            .map(|(v, _)| (*v).to_string())
            .collect::<Vec<_>>()
    );

    // A second boot must be a no-op rather than replaying schema changes.
    db.migrate().await.unwrap();
    assert_eq!(db.applied_migrations().await.unwrap(), applied);
}

#[tokio::test]
async fn migration_preserves_legacy_certificate_host_kv() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..10]).await;
    sqlx::query(
        "INSERT INTO host_kv (key, value, updated_at) VALUES ('certs.dev_ca', 'legacy-unsealed-value', 't')",
    )
    .execute(&pool)
    .await
    .unwrap();
    apply_migration(
        &pool,
        include_str!("../../../migrations/0013_certificate_issuance.sql"),
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM host_kv WHERE key = 'certs.dev_ca'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "legacy-unsealed-value"
    );
}

#[tokio::test]
async fn atomic_certificate_authority_default_is_org_scoped_and_cas_guarded() {
    let db = Db::connect_memory().await.unwrap();
    let internal = certificate_authority("org:one", "ca:internal", true);
    let external = certificate_authority("org:one", "ca:external", false);
    db.insert_certificate_authority(&internal).await.unwrap();
    db.insert_certificate_authority(&external).await.unwrap();

    assert!(!db
        .set_default_certificate_authority("org:two", "ca:external", 1)
        .await
        .unwrap());
    assert!(db
        .set_default_certificate_authority("org:one", "ca:external", 1)
        .await
        .unwrap());
    assert_eq!(
        db.get_default_certificate_authority("org:one")
            .await
            .unwrap()
            .unwrap()
            .id,
        "ca:external"
    );
    assert!(!db
        .set_default_certificate_authority("org:one", "ca:internal", 1)
        .await
        .unwrap());

    let duplicate_default = certificate_authority("org:one", "ca:duplicate", true);
    assert!(db
        .insert_certificate_authority(&duplicate_default)
        .await
        .is_err());
}

#[tokio::test]
async fn adversarial_certificate_completion_rejects_substitution_and_replay() {
    let db = Db::connect_memory().await.unwrap();
    let authority = certificate_authority("org:one", "ca:one", true);
    db.insert_certificate_authority(&authority).await.unwrap();
    let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
    assert!(db
        .insert_certificate_issuance_request(&request)
        .await
        .unwrap());

    let mut duplicate = certificate_request("org:one", "ca:one", "request:two", "idem:one");
    duplicate.request_digest = "sha256:other".into();
    assert!(db
        .insert_certificate_issuance_request(&duplicate)
        .await
        .is_err());

    let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
    let mut substituted = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
    substituted.common_name = "attacker.example".into();
    assert!(!db
        .complete_certificate_issuance(
            "org:one",
            "request:one",
            1,
            "created",
            &delivery,
            &substituted,
        )
        .await
        .unwrap());

    let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
    assert!(db
        .complete_certificate_issuance("org:one", "request:one", 1, "created", &delivery, &issued,)
        .await
        .unwrap());
    assert!(!db
        .complete_certificate_issuance("org:one", "request:one", 1, "created", &delivery, &issued,)
        .await
        .unwrap());
    assert_eq!(
        db.get_issued_certificate("org:one", "certificate:one")
            .await
            .unwrap(),
        Some(issued)
    );
    assert!(db
        .get_issued_certificate("org:two", "certificate:one")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn atomic_certificate_delivery_is_encrypted_expiring_and_single_use() {
    let db = Db::connect_memory().await.unwrap();
    let authority = certificate_authority("org:one", "ca:one", true);
    db.insert_certificate_authority(&authority).await.unwrap();
    let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
    db.insert_certificate_issuance_request(&request)
        .await
        .unwrap();
    let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
    let debug = format!("{delivery:?}");
    assert!(!debug.contains("[9, 8, 7]"));
    assert!(!debug.contains("[6, 5, 4]"));
    let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
    db.complete_certificate_issuance("org:one", "request:one", 1, "created", &delivery, &issued)
        .await
        .unwrap();

    assert!(db
        .take_certificate_delivery("org:two", "request:one", "2026-08-21T00:00:00+00:00")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        db.take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap(),
        Some(delivery)
    );
    assert!(db
        .take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
        .await
        .unwrap()
        .is_none());

    let expired_request =
        certificate_request("org:one", "ca:one", "request:expired", "idem:expired");
    db.insert_certificate_issuance_request(&expired_request)
        .await
        .unwrap();
    let expired_issued = issued_certificate(
        "org:one",
        "ca:one",
        "request:expired",
        "certificate:expired",
    );
    db.complete_certificate_issuance(
        "org:one",
        "request:expired",
        1,
        "created",
        &certificate_delivery("2026-08-20T00:00:00+00:00"),
        &expired_issued,
    )
    .await
    .unwrap();
    assert!(db
        .take_certificate_delivery("org:one", "request:expired", "2026-08-21T00:00:00+00:00")
        .await
        .unwrap()
        .is_none());
    assert!(sqlx::query_scalar::<_, Option<Vec<u8>>>(
        "SELECT delivery_ciphertext FROM certificate_issuance_requests WHERE id = 'request:expired'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap()
    .is_none());

    let columns = sqlx::query("PRAGMA table_info(issued_certificates)")
        .fetch_all(db.pool())
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();
    assert!(columns.iter().all(|column| {
        !column.contains("private") && !column.contains("ciphertext") && !column.contains("nonce")
    }));
}

#[tokio::test]
async fn contract_certificate_delivery_retries_until_holder_acknowledges() {
    let db = Db::connect_memory().await.unwrap();
    db.insert_certificate_authority(&certificate_authority("org:one", "ca:one", true))
        .await
        .unwrap();
    let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
    db.insert_certificate_issuance_request(&request)
        .await
        .unwrap();
    let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
    db.complete_certificate_issuance(
        "org:one",
        "request:one",
        1,
        "created",
        &delivery,
        &issued_certificate("org:one", "ca:one", "request:one", "certificate:one"),
    )
    .await
    .unwrap();

    assert!(db
        .get_certificate_delivery(
            "org:one",
            "request:one",
            "principal:attacker",
            "2026-08-21T00:00:00+00:00",
        )
        .await
        .unwrap()
        .is_none());
    for _ in 0..2 {
        assert_eq!(
            db.get_certificate_delivery(
                "org:one",
                "request:one",
                "principal:owner",
                "2026-08-21T00:00:00+00:00",
            )
            .await
            .unwrap(),
            Some(delivery.clone())
        );
    }
    assert!(db
        .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
        .await
        .unwrap());
    assert!(db
        .get_certificate_delivery(
            "org:one",
            "request:one",
            "principal:owner",
            "2026-08-21T00:00:00+00:00",
        )
        .await
        .unwrap()
        .is_none());
    assert!(!db
        .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
        .await
        .unwrap());
}

#[tokio::test]
async fn migrating_an_existing_database_records_without_destroying() {
    let db = Db::connect_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, shareability, max_invoke_level, egress_json, created_at, updated_at) \
         VALUES ('c1','org:1',NULL,'github','github/main','GitHub','pending',NULL,'[]','[]',NULL,'organization','private',2,'{}','t','t')",
    )
    .execute(db.pool())
    .await
    .unwrap();

    db.migrate().await.unwrap();

    let row = sqlx::query("SELECT COUNT(*) AS c FROM connections")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("c"), 1);
}

#[tokio::test]
async fn legacy_connection_rows_survive_the_broker_migration() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for statement in split_statements(include_str!("../../../migrations/0001_init.sql")) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES ('org:1', 'Legacy', 't')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO connections (id, organization_id, project_id, connector_id, connector_version, component_digest, display_name, policy_json, created_at) VALUES ('legacy-1', 'org:1', NULL, 'github', '1', 'sha256:x', 'Legacy', '{}', 't')")
        .execute(&pool)
        .await
        .unwrap();

    let db = Db { pool };
    db.migrate().await.unwrap();
    let legacy = sqlx::query("SELECT id FROM legacy_connections WHERE id = 'legacy-1'")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(legacy.get::<String, _>("id"), "legacy-1");
    let broker_rows = sqlx::query("SELECT COUNT(*) AS n FROM connections")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(broker_rows.get::<i64, _>("n"), 0);
}

#[tokio::test]
async fn credential_generation_migration_backfills_baseline_rows() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..4]).await;
    sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'deployment:stripe')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO connection_credentials (connection_id, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', X'01', X'02', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
        .execute(&pool)
        .await
        .unwrap();
    for statement in split_statements(include_str!(
        "../../../migrations/0005_credential_generation.sql"
    )) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }
    let version = sqlx::query("SELECT version FROM connection_credentials")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<String, _>("version");
    assert!(!version.is_empty());
}

#[tokio::test]
async fn provider_configuration_migration_indexes_legacy_fields_without_rewriting_secrets() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..5]).await;
    sqlx::query("INSERT INTO integrations (id, organization_id, key, provider_id, display_name, enabled, scopes, client_id, client_secret_ciphertext, client_secret_nonce, client_secret_aad_digest, created_by, created_at, updated_at) VALUES ('integration:legacy', 'org:legacy', 'legacy', 'github', 'Legacy', 1, '[]', 'client', X'01', X'02', 'aad', 'principal:admin', 't', 't')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'integration:legacy')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO connection_credentials (connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', 'v1', X'03', X'04', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
        .execute(&pool)
        .await
        .unwrap();

    for statement in split_statements(include_str!(
        "../../../migrations/0006_provider_configuration.sql"
    )) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }

    let integration_fields =
        sqlx::query("SELECT configured_fields FROM integrations WHERE id = 'integration:legacy'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<String, _>("configured_fields");
    let connection_fields = sqlx::query(
        "SELECT configured_fields FROM connection_credentials WHERE connection_id = 'connection:legacy'",
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .get::<String, _>("configured_fields");
    assert_eq!(integration_fields, r#"["client_id","client_secret"]"#);
    assert_eq!(connection_fields, r#"["api_key"]"#);
}

#[tokio::test]
async fn provider_connections_are_added_to_an_already_migrated_database() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..6]).await;
    assert!(sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
        .execute(&pool)
        .await
        .is_err());
    for statement in split_statements(include_str!(
        "../../../migrations/0007_provider_connections.sql"
    )) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }
    sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
        .execute(&pool)
        .await
        .unwrap();
}

#[test]
fn statements_split_cleanly() {
    for (version, sql) in MIGRATIONS {
        let stmts = split_statements(sql);
        assert!(!stmts.is_empty(), "{version} produced no statements");
        assert!(
            stmts.iter().all(|s| !s.contains("--")),
            "{version} left a line comment inside a statement"
        );
    }
}

#[tokio::test]
async fn outbox_claim_publish_park_dead_letter_lifecycle() {
    let db = Db::connect_memory().await.unwrap();
    let first = db
        .append_outbox("sync.blob.written", r#"{"blob_id":"b1"}"#)
        .await
        .unwrap();
    let second = db
        .append_outbox("connection.credential.stored", r#"{"connection_id":"c1"}"#)
        .await
        .unwrap();
    assert_eq!(db.count_unpublished_outbox().await.unwrap(), 2);

    // Claiming leases the rows: a second immediate claim sees nothing.
    let claimed = db.claim_outbox_batch(10, 60).await.unwrap();
    assert_eq!(claimed.len(), 2);
    assert_eq!(claimed[0].id, first);
    assert!(db.claim_outbox_batch(10, 60).await.unwrap().is_empty());

    // Success path.
    db.mark_outbox_published(&[first.clone()]).await.unwrap();
    assert_eq!(db.count_unpublished_outbox().await.unwrap(), 1);

    // Compensation path: park releases the claim after the backoff.
    db.park_outbox(&[second.clone()], "github 502", 0)
        .await
        .unwrap();
    let retried = db.claim_outbox_batch(10, 60).await.unwrap();
    assert_eq!(retried.len(), 1);
    assert_eq!(retried[0].id, second);
    assert_eq!(retried[0].attempts, 1);

    // Terminal compensation: dead-letter records the error and stops retries.
    db.dead_letter_outbox(&[second.clone()], "poison payload")
        .await
        .unwrap();
    assert_eq!(db.count_unpublished_outbox().await.unwrap(), 0);
}

#[tokio::test]
async fn sync_blob_writes_broadcast_an_outbox_event_atomically() {
    let db = Db::connect_memory().await.unwrap();
    let blob = StoredSyncBlob {
        id: "blob-1".into(),
        epoch: 1,
        ciphertext: vec![1, 2, 3],
    };
    assert_eq!(
        db.write_sync_blob("owner-1", &blob, 10, 10).await.unwrap(),
        SyncWriteOutcome::Accepted
    );
    let events = db.claim_outbox_batch(10, 60).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "sync.blob.written");
    assert!(events[0].payload_json.contains("blob-1"));
}

#[tokio::test]
async fn backup_target_round_trip_and_outcome_recording() {
    let db = Db::connect_memory().await.unwrap();
    let organization = OrganizationId::new();
    sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)")
        .bind(organization.to_string())
        .bind(Utc::now().to_rfc3339())
        .execute(db.pool())
        .await
        .unwrap();
    let target = BackupTarget {
        organization_id: organization.to_string(),
        integration_id: "github-app-1".into(),
        installation_id: "12345678".into(),
        owner: "acme".into(),
        repo: "opensesame-passwords".into(),
        branch: "main".into(),
        enabled: true,
        status: "pending".into(),
        last_commit_sha: None,
        last_synced_at: None,
        last_error: None,
        kind: "github_app".into(),
        provider_id: None,
        connection_id: None,
        config: None,
    };
    db.upsert_backup_target(&target).await.unwrap();
    let loaded = db
        .get_backup_target(&organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.repo, "opensesame-passwords");
    assert!(loaded.enabled);

    db.record_backup_outcome(&organization.to_string(), "ok", Some("abc123"), None)
        .await
        .unwrap();
    let synced = db
        .get_backup_target(&organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(synced.status, "ok");
    assert_eq!(synced.last_commit_sha.as_deref(), Some("abc123"));
    assert!(synced.last_synced_at.is_some());

    // A failed pass keeps the last good commit but records the error.
    db.record_backup_outcome(&organization.to_string(), "suspended", None, Some("401"))
        .await
        .unwrap();
    let suspended = db
        .get_backup_target(&organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(suspended.status, "suspended");
    assert_eq!(suspended.last_commit_sha.as_deref(), Some("abc123"));
    assert_eq!(suspended.last_error.as_deref(), Some("401"));
}

#[tokio::test]
async fn host_kv_round_trip_and_overwrite() {
    let db = Db::connect_memory().await.unwrap();
    assert!(db.get_host_kv("taskbus.backend").await.unwrap().is_none());
    db.set_host_kv("taskbus.backend", "memory").await.unwrap();
    db.set_host_kv("taskbus.nats_url", "nats://127.0.0.1:4222")
        .await
        .unwrap();
    assert_eq!(
        db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
        Some("memory")
    );
    db.set_host_kv("taskbus.backend", "nats").await.unwrap();
    assert_eq!(
        db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
        Some("nats")
    );
    db.delete_host_kv("taskbus.nats_url").await.unwrap();
    assert!(db.get_host_kv("taskbus.nats_url").await.unwrap().is_none());
    db.set_host_kv("github.delivery.abc", "outbox-1")
        .await
        .unwrap();
    assert_eq!(
        db.get_host_kv("github.delivery.abc")
            .await
            .unwrap()
            .as_deref(),
        Some("outbox-1")
    );
    assert!(!db
        .try_claim_host_kv("github.delivery.abc", "outbox-2")
        .await
        .unwrap());
    assert!(db
        .try_claim_host_kv("github.delivery.new", "outbox-3")
        .await
        .unwrap());
}

#[tokio::test]
async fn try_claim_host_kv_is_exclusive_under_concurrency() {
    let db = Db::connect_memory().await.unwrap();
    let db = std::sync::Arc::new(db);
    let mut handles = Vec::new();
    for i in 0..32 {
        handles.push(tokio::spawn(claim_host_kv(db.clone(), i)));
    }
    let mut wins = 0usize;
    for handle in handles {
        wins += usize::from(handle.await.unwrap());
    }
    assert_eq!(wins, 1);
    assert!(db
        .get_host_kv("github.delivery.race")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn backup_outbox_migration_applies_to_an_already_migrated_database() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    // 0015 alters backup_targets, so it must trail 0008 here just as it
    // does in the real ordered list.
    let except_backup: Vec<(&str, &str)> = MIGRATIONS
        .iter()
        .copied()
        .filter(|(version, _)| {
            *version != "0008_backup_outbox" && *version != "0015_backup_target_kinds"
        })
        .collect();
    apply_migrations(&pool, &except_backup).await;
    assert!(sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
        .execute(&pool)
        .await
        .is_err());
    for statement in split_statements(include_str!("../../../migrations/0008_backup_outbox.sql")) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }
    for statement in split_statements(include_str!(
        "../../../migrations/0015_backup_target_kinds.sql"
    )) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }
    sqlx::query("SELECT attempts FROM outbox_events LIMIT 0")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
        .execute(&pool)
        .await
        .unwrap();
}

// —— certificate manager fixtures ——————————————————————————————

const CERTMGR_NOW: &str = "2026-08-30T00:00:00+00:00";

fn certmgr_policy(organization_id: &str, id: &str, name: &str) -> StoredCertificatePolicy {
    StoredCertificatePolicy {
        id: id.into(),
        organization_id: organization_id.into(),
        name: name.into(),
        description: Some("TLS server issuance".into()),
        preset: "tls_server".into(),
        max_validity_seconds: Some(7_776_000),
        rules_json: r#"{"subject":{},"san":{}}"#.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_profile(
    organization_id: &str,
    id: &str,
    name: &str,
    authority_id: &str,
    policy_id: &str,
) -> StoredCertificateProfile {
    StoredCertificateProfile {
        id: id.into(),
        organization_id: organization_id.into(),
        name: name.into(),
        issuer_type: "ca".into(),
        certificate_authority_id: Some(authority_id.into()),
        policy_id: policy_id.into(),
        defaults_json: r#"{"ttl_seconds":86400}"#.into(),
        external_template: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_application(organization_id: &str, id: &str, slug: &str) -> StoredPkiApplication {
    StoredPkiApplication {
        id: id.into(),
        organization_id: organization_id.into(),
        slug: slug.into(),
        display_name: "Edge fleet".into(),
        description: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_sealed(tag: &str) -> SealedCertificateMaterial {
    SealedCertificateMaterial {
        key_id: format!("seal:{tag}"),
        ciphertext: vec![7, 7, 7],
        nonce: vec![3, 3, 3],
        aad_digest: format!("sha256:{tag}"),
    }
}

fn certmgr_managed_certificate(
    organization_id: &str,
    authority_id: &str,
    request_id: &str,
    id: &str,
) -> StoredManagedCertificate {
    StoredManagedCertificate {
        id: id.into(),
        organization_id: organization_id.into(),
        authority_id: authority_id.into(),
        request_id: request_id.into(),
        certificate_digest: format!("sha256:{id}"),
        serial_number: id.into(),
        common_name: "alpha.example".into(),
        san_json: r#"{"dns_names":["alpha.example"],"ip_addrs":[]}"#.into(),
        not_before: CERTMGR_NOW.into(),
        expires_at: "2026-12-01T00:00:00+00:00".into(),
        status: "active".into(),
        application_id: None,
        profile_id: None,
        source: "issued".into(),
        enrollment_method: Some("api".into()),
        metadata_json: "{}".into(),
        key_algorithm: Some("ecdsa-p256".into()),
        signature_algorithm: Some("ecdsa-with-sha256".into()),
        fingerprint_sha256: Some(format!("fp:{id}")),
        chain_pem: None,
        renewed_from_id: None,
        renewed_by_id: None,
        auto_renew_enabled: false,
        renew_before_seconds: None,
        revocation_reason: None,
        revoked_at: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

/// Seed one organization with a CA, a policy, a profile and an application.
/// Returns `(authority_id, policy_id, profile_id, application_id)`.
async fn seed_certmgr_org(
    db: &Db,
    organization_id: &str,
    suffix: &str,
) -> (String, String, String, String) {
    let authority_id = format!("ca:{suffix}");
    let policy_id = format!("policy:{suffix}");
    let profile_id = format!("profile:{suffix}");
    let application_id = format!("app:{suffix}");
    db.insert_certificate_authority(&certificate_authority(organization_id, &authority_id, true))
        .await
        .unwrap();
    db.insert_certificate_policy(&certmgr_policy(organization_id, &policy_id, "tls"))
        .await
        .unwrap();
    db.insert_certificate_profile(&certmgr_profile(
        organization_id,
        &profile_id,
        "edge",
        &authority_id,
        &policy_id,
    ))
    .await
    .unwrap();
    db.insert_pki_application(&certmgr_application(
        organization_id,
        &application_id,
        "edge",
    ))
    .await
    .unwrap();
    (authority_id, policy_id, profile_id, application_id)
}

/// Record an issuance request and its certificate. The 0013 schema keeps
/// `request_id` a NOT NULL foreign key, so inventory rows always have one.
async fn seed_certificate(
    db: &Db,
    organization_id: &str,
    authority_id: &str,
    suffix: &str,
) -> StoredManagedCertificate {
    let request_id = format!("request:{suffix}");
    db.insert_certificate_issuance_request(&certificate_request(
        organization_id,
        authority_id,
        &request_id,
        &format!("idem:{suffix}"),
    ))
    .await
    .unwrap();
    let certificate = certmgr_managed_certificate(
        organization_id,
        authority_id,
        &request_id,
        &format!("cert:{suffix}"),
    );
    db.insert_managed_certificate(&certificate).await.unwrap();
    certificate
}

fn certmgr_signer(organization_id: &str, id: &str, name: &str) -> StoredSigner {
    StoredSigner {
        id: id.into(),
        organization_id: organization_id.into(),
        name: name.into(),
        certificate_id: None,
        key_source: "sealed".into(),
        hsm_connector_id: None,
        hsm_key_label: None,
        status: "active".into(),
        auto_renew: false,
        renew_before_seconds: None,
        sealed_key: Some(certmgr_sealed("signer")),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_approval_policy(
    organization_id: &str,
    id: &str,
    name: &str,
    application_id: &str,
) -> StoredApprovalPolicy {
    StoredApprovalPolicy {
        id: id.into(),
        organization_id: organization_id.into(),
        scope: "issuance".into(),
        application_id: Some(application_id.into()),
        signer_id: None,
        name: name.into(),
        max_request_ttl_seconds: Some(3600),
        machine_bypass: false,
        covers_json: "[]".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_approval_request(
    organization_id: &str,
    id: &str,
    policy_id: &str,
) -> StoredApprovalRequest {
    StoredApprovalRequest {
        id: id.into(),
        organization_id: organization_id.into(),
        policy_id: policy_id.into(),
        kind: "issuance".into(),
        requester: "principal:requester".into(),
        status: "open".into(),
        current_step: 0,
        expires_at: "2099-01-01T00:00:00+00:00".into(),
        payload_digest: "sha256:payload".into(),
        scope_json: "{}".into(),
        result_id: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_installation(
    organization_id: &str,
    id: &str,
    job_id: &str,
    host: &str,
) -> StoredDiscoveryInstallation {
    StoredDiscoveryInstallation {
        id: id.into(),
        organization_id: organization_id.into(),
        job_id: job_id.into(),
        host: host.into(),
        port: 443,
        fingerprint_sha256: "fp:observed".into(),
        cn: Some(host.into()),
        issuer: Some("CN=Edge".into()),
        not_after: Some("2026-12-01T00:00:00+00:00".into()),
        first_seen_at: CERTMGR_NOW.into(),
        last_seen_at: CERTMGR_NOW.into(),
        change_log_json: "[]".into(),
        matched_certificate_id: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_discovery_job(organization_id: &str, id: &str, name: &str) -> StoredDiscoveryJob {
    StoredDiscoveryJob {
        id: id.into(),
        organization_id: organization_id.into(),
        name: name.into(),
        description: None,
        targets_json: r#"{"domains":["example.com"],"ips":[],"cidrs":[]}"#.into(),
        ports_json: "[443]".into(),
        auto_scan: false,
        scan_interval_days: Some(7),
        gateway_ref: None,
        allow_internal: false,
        last_scan_at: None,
        status: "idle".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

fn certmgr_access_record(
    organization_id: &str,
    id: &str,
    signer_id: &str,
    allowed: Option<i64>,
) -> StoredSigningAccessRecord {
    StoredSigningAccessRecord {
        id: id.into(),
        organization_id: organization_id.into(),
        signer_id: signer_id.into(),
        approval_request_id: None,
        status: "active".into(),
        signatures_allowed: allowed,
        signatures_used: 0,
        window_expires_at: Some("2099-01-01T00:00:00+00:00".into()),
        scope_json: "{}".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    }
}

// —— certificate manager unit tests ————————————————————————————

#[tokio::test]
async fn certmgr_migration_applies_from_an_empty_database() {
    let db = Db::connect_memory().await.unwrap();
    assert!(db
        .applied_migrations()
        .await
        .unwrap()
        .contains(&"0016_certificate_manager".to_string()));
    for table in [
        "certificate_policies",
        "certificate_profiles",
        "pki_applications",
        "pki_application_members",
        "enrollment_configs",
        "managed_certificate_keys",
        "certificate_revocations",
        "crl_state",
        "discovery_jobs",
        "discovery_installations",
        "hsm_connectors",
        "external_ca_configs",
        "signers",
        "signer_members",
        "approval_policies",
        "approval_steps",
        "approval_requests",
        "approval_decisions",
        "signing_access_records",
        "signing_events",
        "cert_alerts",
        "alert_deliveries",
        "cert_syncs",
        "sync_runs",
        "acme_server_accounts",
        "acme_orders",
        "acme_challenges",
        "acme_nonces",
        "est_configs",
        "scep_configs",
        "scep_challenges",
    ] {
        sqlx::query(&format!("SELECT 1 FROM {table} LIMIT 0"))
            .execute(db.pool())
            .await
            .unwrap_or_else(|error| panic!("{table} is missing: {error}"));
    }
}

#[tokio::test]
async fn certmgr_policies_and_profiles_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, policy_id, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
    let stored = db
        .get_certificate_policy("org:one", &policy_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.preset, "tls_server");
    assert_eq!(
        db.list_certificate_policies("org:one").await.unwrap().len(),
        1
    );

    let profile = db
        .get_certificate_profile("org:one", &profile_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        profile.certificate_authority_id.as_deref(),
        Some(&*authority)
    );
    assert_eq!(
        db.list_certificate_profiles("org:one").await.unwrap().len(),
        1
    );

    let mut renamed = profile.clone();
    renamed.name = "edge-renamed".into();
    assert!(db.update_certificate_profile(&renamed).await.unwrap());
    assert!(db
        .delete_certificate_profile("org:one", &profile_id)
        .await
        .unwrap());
    assert!(db
        .delete_certificate_policy("org:one", &policy_id)
        .await
        .unwrap());
}

#[tokio::test]
async fn certmgr_application_membership_resolves_effective_roles() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    let member = StoredPkiApplicationMember {
        id: "member:one".into(),
        organization_id: "org:one".into(),
        application_id: application_id.clone(),
        subject: "principal:ada".into(),
        role: "operator".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.upsert_application_member(&member).await.unwrap();
    assert_eq!(
        db.effective_app_role("org:one", &application_id, "principal:ada")
            .await
            .unwrap(),
        Some(Role::Operator)
    );

    let mut promoted = member.clone();
    promoted.role = "admin".into();
    db.upsert_application_member(&promoted).await.unwrap();
    assert_eq!(
        db.effective_app_role("org:one", &application_id, "principal:ada")
            .await
            .unwrap(),
        Some(Role::Admin)
    );
    assert_eq!(
        db.list_application_members("org:one", &application_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .remove_application_member("org:one", &application_id, "principal:ada")
        .await
        .unwrap());
    assert!(db
        .effective_app_role("org:one", &application_id, "principal:ada")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn certmgr_enrollment_configuration_round_trips_its_sealed_secret() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    let config = StoredEnrollmentConfig {
        id: "enroll:one".into(),
        organization_id: "org:one".into(),
        application_id: application_id.clone(),
        profile_id: profile_id.clone(),
        method: "est".into(),
        enabled: true,
        config_json: r#"{"port":8443}"#.into(),
        auto_renew_enabled: true,
        renew_before_seconds: Some(86_400),
        sealed_secret: Some(certmgr_sealed("enrollment")),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_enrollment_config(&config).await.unwrap();
    let stored = db
        .get_enrollment_config("org:one", "enroll:one")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.sealed_secret, Some(certmgr_sealed("enrollment")));
    assert_eq!(
        db.get_enrollment_by_profile_method("org:one", &profile_id, "est")
            .await
            .unwrap()
            .map(|found| found.id),
        Some("enroll:one".to_string())
    );
    assert_eq!(
        db.list_enrollment_configs("org:one", &application_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db.update_enrollment_config(&stored).await.unwrap());
    assert!(db
        .delete_enrollment_config("org:one", "enroll:one")
        .await
        .unwrap());
}

#[tokio::test]
async fn certmgr_inventory_round_trips_with_metadata_and_managed_key() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
    let stored = db
        .get_certificate("org:one", &certificate.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored, certificate);

    assert!(db
        .set_certificate_metadata("org:one", &certificate.id, r#"{"team":"platform"}"#)
        .await
        .unwrap());
    assert_eq!(
        db.get_certificate_metadata("org:one", &certificate.id)
            .await
            .unwrap()
            .as_deref(),
        Some(r#"{"team":"platform"}"#)
    );

    let key = StoredManagedCertificateKey {
        id: "key:alpha".into(),
        organization_id: "org:one".into(),
        certificate_id: certificate.id.clone(),
        sealed_key: certmgr_sealed("leaf"),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_managed_certificate_key(&key).await.unwrap();
    assert_eq!(
        db.get_managed_certificate_key("org:one", &certificate.id)
            .await
            .unwrap()
            .map(|found| found.sealed_key),
        Some(certmgr_sealed("leaf"))
    );
    assert!(db
        .delete_managed_certificate_key("org:one", &certificate.id)
        .await
        .unwrap());
    assert!(db
        .delete_certificate("org:one", &certificate.id)
        .await
        .unwrap());
}

#[tokio::test]
async fn certmgr_managed_key_custody_never_widens_the_inventory_row() {
    let db = Db::connect_memory().await.unwrap();
    let columns: Vec<String> = sqlx::query("PRAGMA table_info(issued_certificates)")
        .fetch_all(db.pool())
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();
    assert!(columns.iter().all(|column| {
        !column.contains("private")
            && !column.contains("ciphertext")
            && !column.contains("nonce")
            && !column.contains("sealed")
    }));

    // Private key material lives in exactly three tables: the pre-0016
    // authority keys, code-signing keys, and managed leaf keys. The
    // inventory row is not one of them.
    let key_tables: Vec<String> = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%sealed\\_key%' ESCAPE '\\' ORDER BY name",
    )
    .fetch_all(db.pool())
    .await
    .unwrap()
    .into_iter()
    .map(|row| row.get::<String, _>("name"))
    .collect();
    assert_eq!(
        key_tables,
        vec![
            "certificate_authorities",
            "managed_certificate_keys",
            "signers"
        ]
    );

    let sql = CertificateFilter::default().to_query().sql;
    assert!(!sql.contains("managed_certificate_keys"));
    assert!(!sql.contains("sealed"));
}

#[tokio::test]
async fn certmgr_rows_are_isolated_between_organizations() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, policy_id, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    seed_certmgr_org(&db, "org:two", "two").await;
    let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;

    db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
        .await
        .unwrap();
    db.insert_approval_policy(&certmgr_approval_policy(
        "org:one",
        "approval:one",
        "two-step",
        &application_id,
    ))
    .await
    .unwrap();
    db.insert_approval_request(&certmgr_approval_request(
        "org:one",
        "request:approval",
        "approval:one",
    ))
    .await
    .unwrap();
    db.insert_discovery_job(&certmgr_discovery_job("org:one", "job:one", "edge"))
        .await
        .unwrap();
    db.record_installation(&certmgr_installation(
        "org:one",
        "install:one",
        "job:one",
        "alpha.example",
    ))
    .await
    .unwrap();

    assert!(db
        .get_certificate_policy("org:two", &policy_id)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .list_certificate_policies("org:two")
        .await
        .unwrap()
        .iter()
        .all(|policy| policy.id != policy_id));
    assert!(db
        .get_certificate("org:two", &certificate.id)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .list_certificates("org:two", &CertificateFilter::default())
        .await
        .unwrap()
        .is_empty());
    assert!(db
        .get_signer("org:two", "signer:one")
        .await
        .unwrap()
        .is_none());
    assert!(db.list_signers("org:two").await.unwrap().is_empty());
    assert!(db
        .get_approval_request("org:two", "request:approval")
        .await
        .unwrap()
        .is_none());
    assert!(db
        .list_approval_requests("org:two", None)
        .await
        .unwrap()
        .is_empty());
    assert!(db
        .list_installations("org:two", None)
        .await
        .unwrap()
        .is_empty());
    assert!(db
        .match_installation_by_fingerprint("org:two", "fp:observed")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn certmgr_stale_version_loses_the_optimistic_update() {
    let db = Db::connect_memory().await.unwrap();
    let (_, policy_id, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let policy = db
        .get_certificate_policy("org:one", &policy_id)
        .await
        .unwrap()
        .unwrap();
    let mut edit = policy.clone();
    edit.description = Some("first writer".into());
    assert!(db.update_certificate_policy(&edit).await.unwrap());

    let mut stale = policy;
    stale.description = Some("second writer".into());
    assert!(!db.update_certificate_policy(&stale).await.unwrap());
    assert_eq!(
        db.get_certificate_policy("org:one", &policy_id)
            .await
            .unwrap()
            .unwrap()
            .description
            .as_deref(),
        Some("first writer")
    );
}

#[tokio::test]
async fn certmgr_partial_sealed_group_is_rejected_by_the_database() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    let partial = sqlx::query(
        "INSERT INTO enrollment_configs (id, organization_id, application_id, profile_id, method, enabled, config_json, auto_renew_enabled, renew_before_seconds, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, version, created_at, updated_at) \
         VALUES ('enroll:partial', 'org:one', ?, ?, 'scep', 1, '{}', 0, NULL, 'seal:v1', X'0102', X'0304', NULL, 1, ?, ?)",
    )
    .bind(&application_id)
    .bind(&profile_id)
    .bind(CERTMGR_NOW)
    .bind(CERTMGR_NOW)
    .execute(db.pool())
    .await;
    assert!(partial.is_err());

    let mut broken = certmgr_sealed("enrollment");
    broken.nonce.clear();
    let config = StoredEnrollmentConfig {
        id: "enroll:broken".into(),
        organization_id: "org:one".into(),
        application_id,
        profile_id,
        method: "scep".into(),
        enabled: true,
        config_json: "{}".into(),
        auto_renew_enabled: false,
        renew_before_seconds: None,
        sealed_secret: Some(broken),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    assert!(db.insert_enrollment_config(&config).await.is_err());
}

#[tokio::test]
async fn certmgr_scep_challenge_is_single_use_and_expiring() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
    let config = StoredScepConfig {
        id: "scep:one".into(),
        organization_id: "org:one".into(),
        profile_id,
        challenge_mode: "dynamic".into(),
        sealed_static_secret: None,
        ra_signs_with_ca: true,
        include_ca_cert: true,
        allow_cert_renewal: false,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_scep_config(&config).await.unwrap();

    let id = db
        .mint_scep_challenge(
            "org:one",
            "scep:one",
            "sha256:challenge",
            "2099-01-01T00:00:00+00:00",
        )
        .await
        .unwrap();
    db.consume_scep_challenge("org:one", "scep:one", "sha256:challenge")
        .await
        .unwrap();
    assert!(db
        .consume_scep_challenge("org:one", "scep:one", "sha256:challenge")
        .await
        .is_err());
    assert!(db
        .get_scep_challenge("org:one", &id)
        .await
        .unwrap()
        .unwrap()
        .consumed_at
        .is_some());

    db.mint_scep_challenge(
        "org:one",
        "scep:one",
        "sha256:expired",
        "2020-01-01T00:00:00+00:00",
    )
    .await
    .unwrap();
    assert!(db
        .consume_scep_challenge("org:one", "scep:one", "sha256:expired")
        .await
        .is_err());
}

#[tokio::test]
async fn certmgr_acme_nonce_is_single_use() {
    let db = Db::connect_memory().await.unwrap();
    let nonce = db.mint_acme_nonce("org:one").await.unwrap();
    db.consume_acme_nonce("org:one", &nonce).await.unwrap();
    assert!(db.consume_acme_nonce("org:one", &nonce).await.is_err());
    assert!(db
        .consume_acme_nonce("org:one", "never-minted")
        .await
        .is_err());
}

#[tokio::test]
async fn certmgr_signature_count_stops_at_the_cap() {
    let db = Db::connect_memory().await.unwrap();
    seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
        .await
        .unwrap();
    db.insert_signing_access_record(&certmgr_access_record(
        "org:one",
        "record:one",
        "signer:one",
        Some(2),
    ))
    .await
    .unwrap();
    assert_eq!(
        db.increment_signature_count("org:one", "record:one")
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        db.increment_signature_count("org:one", "record:one")
            .await
            .unwrap(),
        2
    );
    assert!(db
        .increment_signature_count("org:one", "record:one")
        .await
        .is_err());
    assert_eq!(
        db.list_active_records("org:one", "signer:one")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .revoke_access_record("org:one", "record:one")
        .await
        .unwrap());
    assert!(db
        .increment_signature_count("org:one", "record:one")
        .await
        .is_err());
}

#[tokio::test]
async fn certmgr_approval_transition_rejects_a_stale_expectation() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_approval_policy(&certmgr_approval_policy(
        "org:one",
        "approval:one",
        "two-step",
        &application_id,
    ))
    .await
    .unwrap();
    db.insert_approval_request(&certmgr_approval_request(
        "org:one",
        "request:approval",
        "approval:one",
    ))
    .await
    .unwrap();
    db.transition_approval_request("org:one", "request:approval", "open", "approved")
        .await
        .unwrap();
    assert!(db
        .transition_approval_request("org:one", "request:approval", "open", "rejected")
        .await
        .is_err());
    assert!(db
        .transition_approval_request("org:two", "request:approval", "approved", "cancelled")
        .await
        .is_err());
}

#[tokio::test]
async fn certmgr_approval_steps_and_decisions_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_approval_policy(&certmgr_approval_policy(
        "org:one",
        "approval:one",
        "two-step",
        &application_id,
    ))
    .await
    .unwrap();
    for seq in 0..2 {
        db.insert_approval_step(&StoredApprovalStep {
            id: format!("step:{seq}"),
            organization_id: "org:one".into(),
            policy_id: "approval:one".into(),
            seq,
            name: format!("step {seq}"),
            approvers_json: r#"["principal:ada"]"#.into(),
            required_count: 1,
            notify: true,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
    }
    assert_eq!(
        db.list_steps_for_policy("org:one", "approval:one")
            .await
            .unwrap()
            .len(),
        2
    );

    db.insert_approval_request(&certmgr_approval_request(
        "org:one",
        "request:approval",
        "approval:one",
    ))
    .await
    .unwrap();
    db.insert_approval_decision(&StoredApprovalDecision {
        id: "decision:one".into(),
        organization_id: "org:one".into(),
        request_id: "request:approval".into(),
        step_seq: 0,
        approver: "principal:ada".into(),
        decision: "approve".into(),
        comment: Some("looks right".into()),
        decided_at: CERTMGR_NOW.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        db.list_decisions_for_request("org:one", "request:approval")
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.advance_approval_step("org:one", "request:approval", 0)
            .await
            .unwrap(),
        1
    );
    assert!(db
        .advance_approval_step("org:one", "request:approval", 0)
        .await
        .is_err());
    assert!(db
        .set_approval_result("org:one", "request:approval", "cert:alpha")
        .await
        .unwrap());
    assert!(db.delete_approval_step("org:one", "step:1").await.unwrap());
    assert_eq!(db.list_approval_policies("org:one").await.unwrap().len(), 1);
}

#[tokio::test]
async fn certmgr_signer_membership_and_activity_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
        .await
        .unwrap();
    db.upsert_signer_member(&StoredSignerMember {
        id: "signer-member:one".into(),
        organization_id: "org:one".into(),
        signer_id: "signer:one".into(),
        subject: "principal:ada".into(),
        role: "administrator".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        db.effective_signer_role("org:one", "signer:one", "principal:ada")
            .await
            .unwrap(),
        Some(Role::Admin)
    );
    assert_eq!(
        db.list_signer_members("org:one", "signer:one")
            .await
            .unwrap()
            .len(),
        1
    );

    db.append_signing_event(&StoredSigningEvent {
        id: "event:one".into(),
        organization_id: "org:one".into(),
        signer_id: "signer:one".into(),
        access_record_id: None,
        outcome: "succeeded".into(),
        command: Some("signtool sign".into()),
        application_name: Some("installer.exe".into()),
        application_sha256: Some("sha256:app".into()),
        hostname: Some("build-01".into()),
        os_username: Some("build".into()),
        ip: Some("10.0.0.4".into()),
        data_hash: Some("sha256:data".into()),
        occurred_at: CERTMGR_NOW.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        db.list_signing_events("org:one", "signer:one")
            .await
            .unwrap()
            .len(),
        1
    );

    let signer = db
        .get_signer("org:one", "signer:one")
        .await
        .unwrap()
        .unwrap();
    assert!(db.update_signer(&signer).await.unwrap());
    assert!(db
        .remove_signer_member("org:one", "signer:one", "principal:ada")
        .await
        .unwrap());
    assert!(db.delete_signer("org:one", "signer:one").await.unwrap());
}

#[tokio::test]
async fn certmgr_alerts_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;

    let alert = StoredCertAlert {
        id: "alert:one".into(),
        organization_id: "org:one".into(),
        application_id,
        alert_type: "expiration".into(),
        before_window_seconds: Some(2_592_000),
        daily_reminder: true,
        channels_json: r#"[{"kind":"email","addresses":["ops@example.com"]}]"#.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_cert_alert(&alert).await.unwrap();
    assert_eq!(
        db.get_cert_alert("org:one", "alert:one")
            .await
            .unwrap()
            .unwrap()
            .alert_type,
        "expiration"
    );
    assert_eq!(
        db.list_cert_alerts("org:one", &alert.application_id)
            .await
            .unwrap()
            .len(),
        1
    );
    db.record_alert_delivery(&StoredAlertDelivery {
        id: "delivery:one".into(),
        organization_id: "org:one".into(),
        alert_id: "alert:one".into(),
        channel: "email".into(),
        outcome: "succeeded".into(),
        attempts: 1,
        last_attempt_at: Some(CERTMGR_NOW.into()),
        payload_digest: "sha256:payload".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        db.list_alert_deliveries("org:one", "alert:one")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db.update_cert_alert(&alert).await.unwrap());
    assert!(db.delete_cert_alert("org:one", "alert:one").await.unwrap());
}

#[tokio::test]
async fn certmgr_syncs_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
    let sync = StoredCertSync {
        id: "sync:one".into(),
        organization_id: "org:one".into(),
        certificate_id: certificate.id.clone(),
        destination_kind: "aws_certificate_manager".into(),
        connection_id: "connection:aws".into(),
        name_schema: "{{certificateId}}".into(),
        remove_on_expiry: true,
        include_root: false,
        options_json: "{}".into(),
        enabled: true,
        last_run_at: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_cert_sync(&sync).await.unwrap();
    assert_eq!(db.list_cert_syncs("org:one").await.unwrap().len(), 1);
    assert_eq!(
        db.list_active_syncs_for_certificate("org:one", &certificate.id)
            .await
            .unwrap()
            .len(),
        1
    );
    db.record_sync_run(&StoredSyncRun {
        id: "run:one".into(),
        organization_id: "org:one".into(),
        sync_id: "sync:one".into(),
        outcome: "succeeded".into(),
        detail: None,
        ran_at: CERTMGR_NOW.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert_eq!(
        db.list_sync_runs("org:one", "sync:one")
            .await
            .unwrap()
            .len(),
        1
    );
    let ran = db
        .get_cert_sync("org:one", "sync:one")
        .await
        .unwrap()
        .unwrap();
    assert!(ran.last_run_at.is_some());
    // The run stamped the parent row, so the pre-run version is now stale.
    assert!(!db.update_cert_sync(&sync).await.unwrap());
    assert!(db.update_cert_sync(&ran).await.unwrap());
    assert!(db.delete_cert_sync("org:one", "sync:one").await.unwrap());
}

#[tokio::test]
async fn certmgr_connectors_and_external_authorities_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    seed_certmgr_org(&db, "org:one", "one").await;
    let connector = StoredHsmConnector {
        id: "hsm:one".into(),
        organization_id: "org:one".into(),
        label: "luna-1".into(),
        sealed_pin: Some(certmgr_sealed("hsm")),
        module_hint: "libcklog2.so".into(),
        key_label_prefix: Some("os-".into()),
        gateway_ref: None,
        status: "unverified".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_hsm_connector(&connector).await.unwrap();
    assert_eq!(
        db.get_hsm_connector("org:one", "hsm:one")
            .await
            .unwrap()
            .unwrap()
            .sealed_pin,
        Some(certmgr_sealed("hsm"))
    );
    assert_eq!(db.list_hsm_connectors("org:one").await.unwrap().len(), 1);
    assert!(db.update_hsm_connector(&connector).await.unwrap());

    let external = StoredExternalCaConfig {
        id: "external:one".into(),
        organization_id: "org:one".into(),
        kind: "aws_pca".into(),
        connection_id: "connection:aws".into(),
        config_json: r#"{"arn":"arn:aws:acm-pca"}"#.into(),
        trust_class: "private_local".into(),
        auto_renew: true,
        renew_before_seconds: Some(2_592_000),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_external_ca_config(&external).await.unwrap();
    assert!(db
        .get_external_ca_config("org:one", "external:one")
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        db.list_external_ca_configs("org:one").await.unwrap().len(),
        1
    );
    assert!(db.update_external_ca_config(&external).await.unwrap());
    assert!(db
        .delete_external_ca_config("org:one", "external:one")
        .await
        .unwrap());
    assert!(db.delete_hsm_connector("org:one", "hsm:one").await.unwrap());
}

#[tokio::test]
async fn certmgr_acme_server_state_round_trips() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_acme_account(&StoredAcmeAccount {
        id: "acme:one".into(),
        organization_id: "org:one".into(),
        profile_id: profile_id.clone(),
        jwk_thumbprint: "thumb:one".into(),
        eab_kid: Some("kid:one".into()),
        status: "valid".into(),
        contacts_json: r#"["mailto:ops@example.com"]"#.into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert!(db
        .get_acme_account("org:one", "acme:one")
        .await
        .unwrap()
        .is_some());
    assert!(db
        .get_acme_account_by_thumbprint("org:one", &profile_id, "thumb:one")
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        db.list_acme_accounts("org:one", &profile_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .update_acme_account_status("org:one", "acme:one", "deactivated")
        .await
        .unwrap());

    db.insert_acme_order(&StoredAcmeOrder {
        id: "order:one".into(),
        organization_id: "org:one".into(),
        account_id: "acme:one".into(),
        status: "pending".into(),
        identifiers_json: r#"[{"type":"dns","value":"alpha.example"}]"#.into(),
        expires_at: "2099-01-01T00:00:00+00:00".into(),
        finalize_csr_pem: None,
        certificate_id: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    db.transition_acme_order("org:one", "order:one", "pending", "ready")
        .await
        .unwrap();
    assert!(db
        .transition_acme_order("org:one", "order:one", "pending", "valid")
        .await
        .is_err());
    assert_eq!(
        db.list_acme_orders("org:one", "acme:one")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .get_acme_order("org:one", "order:one")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn certmgr_acme_challenges_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_acme_account(&StoredAcmeAccount {
        id: "acme:one".into(),
        organization_id: "org:one".into(),
        profile_id,
        jwk_thumbprint: "thumb:one".into(),
        eab_kid: None,
        status: "valid".into(),
        contacts_json: "[]".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    db.insert_acme_order(&StoredAcmeOrder {
        id: "order:one".into(),
        organization_id: "org:one".into(),
        account_id: "acme:one".into(),
        status: "pending".into(),
        identifiers_json: "[]".into(),
        expires_at: "2099-01-01T00:00:00+00:00".into(),
        finalize_csr_pem: None,
        certificate_id: None,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    db.insert_acme_challenge(&StoredAcmeChallenge {
        id: "challenge:one".into(),
        organization_id: "org:one".into(),
        order_id: "order:one".into(),
        authz_id: "authz:one".into(),
        challenge_type: "http-01".into(),
        token: "token:one".into(),
        status: "pending".into(),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    assert!(db
        .update_acme_challenge_status("org:one", "challenge:one", "valid")
        .await
        .unwrap());
    assert_eq!(
        db.get_acme_challenge("org:one", "challenge:one")
            .await
            .unwrap()
            .unwrap()
            .status,
        "valid"
    );
    assert_eq!(
        db.list_acme_challenges("org:one", "order:one")
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn certmgr_est_and_scep_configs_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
    let est = StoredEstConfig {
        id: "est:one".into(),
        organization_id: "org:one".into(),
        profile_id: profile_id.clone(),
        sealed_passphrase: Some(certmgr_sealed("est")),
        bootstrap_chain_pem: None,
        require_bootstrap: true,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_est_config(&est).await.unwrap();
    assert_eq!(
        db.get_est_config("org:one", &profile_id)
            .await
            .unwrap()
            .unwrap()
            .sealed_passphrase,
        Some(certmgr_sealed("est"))
    );
    assert_eq!(db.list_est_configs("org:one").await.unwrap().len(), 1);
    assert!(db.update_est_config(&est).await.unwrap());
    assert!(db.delete_est_config("org:one", "est:one").await.unwrap());

    let scep = StoredScepConfig {
        id: "scep:one".into(),
        organization_id: "org:one".into(),
        profile_id: profile_id.clone(),
        challenge_mode: "static".into(),
        sealed_static_secret: Some(certmgr_sealed("scep")),
        ra_signs_with_ca: true,
        include_ca_cert: true,
        allow_cert_renewal: true,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.insert_scep_config(&scep).await.unwrap();
    assert!(db
        .get_scep_config("org:one", &profile_id)
        .await
        .unwrap()
        .is_some());
    assert_eq!(db.list_scep_configs("org:one").await.unwrap().len(), 1);
    assert!(db.update_scep_config(&scep).await.unwrap());
    assert!(db.delete_scep_config("org:one", "scep:one").await.unwrap());
}

#[tokio::test]
async fn certmgr_discovery_jobs_and_installations_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    seed_certmgr_org(&db, "org:one", "one").await;
    let job = certmgr_discovery_job("org:one", "job:one", "edge");
    db.insert_discovery_job(&job).await.unwrap();
    assert!(db
        .get_discovery_job("org:one", "job:one")
        .await
        .unwrap()
        .is_some());
    assert_eq!(db.list_discovery_jobs("org:one").await.unwrap().len(), 1);
    assert!(db.update_discovery_job(&job).await.unwrap());

    let mut installation =
        certmgr_installation("org:one", "install:one", "job:one", "alpha.example");
    db.record_installation(&installation).await.unwrap();
    installation.last_seen_at = "2026-08-31T00:00:00+00:00".into();
    db.record_installation(&installation).await.unwrap();
    let stored = db
        .list_installations("org:one", Some("job:one"))
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].version, 2);
    assert_eq!(
        db.match_installation_by_fingerprint("org:one", "fp:observed")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db.delete_discovery_job("org:one", "job:one").await.unwrap());
    assert!(db
        .list_installations("org:one", None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn certmgr_revocation_and_crl_state_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
    db.insert_certificate_revocation(&StoredCertificateRevocation {
        id: "revocation:one".into(),
        organization_id: "org:one".into(),
        certificate_id: certificate.id.clone(),
        ca_id: authority.clone(),
        serial: certificate.serial_number.clone(),
        reason_code: 1,
        revoked_at: CERTMGR_NOW.into(),
        crl_number: Some(1),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    })
    .await
    .unwrap();
    let revoked = db
        .get_certificate("org:one", &certificate.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoked.status, "revoked");
    assert_eq!(revoked.revocation_reason, Some(1));
    assert_eq!(
        db.list_revocations_for_ca("org:one", &authority)
            .await
            .unwrap()
            .len(),
        1
    );

    let state = StoredCrlState {
        id: "crl:one".into(),
        organization_id: "org:one".into(),
        ca_id: authority.clone(),
        crl_number: 1,
        this_update: CERTMGR_NOW.into(),
        next_update: "2026-09-06T00:00:00+00:00".into(),
        sealed_der: Some(certmgr_sealed("crl")),
        mirror_urls_json: Some(r#"["https://crl.example/one.crl"]"#.into()),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    db.upsert_crl_state(&state).await.unwrap();
    db.upsert_crl_state(&state).await.unwrap();
    let stored = db
        .get_crl_state("org:one", &authority)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.version, 2);
    assert_eq!(stored.sealed_der, Some(certmgr_sealed("crl")));
    assert!(db
        .get_crl_state("org:two", &authority)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn certmgr_authority_hierarchy_and_signing_config_round_trip() {
    let db = Db::connect_memory().await.unwrap();
    let (root, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_certificate_authority(&certificate_authority("org:one", "ca:intermediate", false))
        .await
        .unwrap();
    assert!(db
        .insert_ca_link("org:one", "ca:intermediate", &root)
        .await
        .unwrap());
    assert_eq!(db.get_ca_children("org:one", &root).await.unwrap().len(), 1);
    assert_eq!(
        db.get_ca_parent("org:one", "ca:intermediate")
            .await
            .unwrap()
            .map(|parent| parent.id),
        Some(root.clone())
    );
    assert!(db.insert_ca_link("org:one", &root, &root).await.is_err());
    assert!(db
        .insert_ca_link("org:two", "ca:intermediate", &root)
        .await
        .is_err());

    let config = db
        .get_signing_config("org:one", "ca:intermediate")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(config.kind, "intermediate");
    let mut edited = config.clone();
    edited.crl_enabled = false;
    edited.crl_mirrors_json = Some(r#"["https://crl.example/int.crl"]"#.into());
    assert!(db.update_signing_config(&edited).await.unwrap());
    assert!(!db.update_signing_config(&config).await.unwrap());

    assert!(db
        .set_ca_pending_csr(
            "org:one",
            "ca:intermediate",
            "-----BEGIN CERTIFICATE REQUEST-----"
        )
        .await
        .unwrap());
    let pending = db
        .get_signing_config("org:one", "ca:intermediate")
        .await
        .unwrap()
        .unwrap();
    assert!(pending.pending_csr_pem.is_some());
    assert!(db
        .complete_ca_import(
            "org:one",
            "ca:intermediate",
            pending.version,
            r#"{"chain":1}"#
        )
        .await
        .unwrap());
    assert!(db
        .get_signing_config("org:one", "ca:intermediate")
        .await
        .unwrap()
        .unwrap()
        .pending_csr_pem
        .is_none());
}

#[tokio::test]
async fn certmgr_renewal_link_is_recorded_in_both_directions() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let first = seed_certificate(&db, "org:one", &authority, "alpha").await;
    let second = seed_certificate(&db, "org:one", &authority, "beta").await;
    db.insert_renewal_link("org:one", &first.id, &second.id)
        .await
        .unwrap();
    assert_eq!(
        db.get_renewed_by("org:one", &first.id)
            .await
            .unwrap()
            .map(|found| found.id),
        Some(second.id.clone())
    );
    assert_eq!(
        db.get_renewed_from("org:one", &second.id)
            .await
            .unwrap()
            .map(|found| found.id),
        Some(first.id.clone())
    );
    assert!(db
        .insert_renewal_link("org:one", &first.id, &first.id)
        .await
        .is_err());
    assert!(db
        .insert_renewal_link("org:two", &first.id, &second.id)
        .await
        .is_err());
}

/// Seed three certificates that differ in status, subject, SAN, profile,
/// application, expiry and metadata. Returns
/// `(alpha_id, gamma_id, profile_id, application_id)`.
async fn seed_filter_fixture(db: &Db) -> (String, String, String, String) {
    let (authority, _, profile_id, application_id) = seed_certmgr_org(db, "org:one", "one").await;
    let alpha = seed_certificate(db, "org:one", &authority, "alpha").await;

    db.insert_certificate_issuance_request(&certificate_request(
        "org:one",
        &authority,
        "request:beta",
        "idem:beta",
    ))
    .await
    .unwrap();
    let mut beta = certmgr_managed_certificate("org:one", &authority, "request:beta", "cert:beta");
    beta.common_name = "beta.internal".into();
    beta.san_json = r#"{"dns_names":["beta.internal"],"ip_addrs":[]}"#.into();
    beta.profile_id = Some(profile_id.clone());
    beta.application_id = Some(application_id.clone());
    beta.status = "revoked".into();
    beta.expires_at = "2027-06-01T00:00:00+00:00".into();
    db.insert_managed_certificate(&beta).await.unwrap();

    db.insert_certificate_issuance_request(&certificate_request(
        "org:one",
        &authority,
        "request:gamma",
        "idem:gamma",
    ))
    .await
    .unwrap();
    let mut gamma =
        certmgr_managed_certificate("org:one", &authority, "request:gamma", "cert:gamma");
    gamma.common_name = "gamma.example".into();
    gamma.san_json = r#"{"dns_names":["gamma.example"],"ip_addrs":[]}"#.into();
    gamma.metadata_json = r#"{"team":"platform"}"#.into();
    gamma.expires_at = "2028-01-01T00:00:00+00:00".into();
    db.insert_managed_certificate(&gamma).await.unwrap();
    (alpha.id, gamma.id, profile_id, application_id)
}

#[tokio::test]
async fn certmgr_list_certificates_filters_narrow_the_result() {
    let db = Db::connect_memory().await.unwrap();
    let (alpha_id, _, profile_id, application_id) = seed_filter_fixture(&db).await;

    let all = db
        .list_certificates("org:one", &CertificateFilter::default())
        .await
        .unwrap();
    assert_eq!(all.len(), 3);

    let active = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                status: Some("active".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(active.len(), 2);

    let by_cn = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                common_name_contains: Some("beta".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(by_cn.len(), 1);

    let by_san = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                san_contains: Some("gamma.example".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(by_san.len(), 1);

    let by_profile = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                profile_id: Some(profile_id),
                application_id: Some(application_id),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(by_profile.len(), 1);

    let expiring = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                expiring_before: Some("2027-01-01T00:00:00+00:00".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(expiring.len(), 1);
    assert_eq!(expiring[0].id, alpha_id);
}

#[tokio::test]
async fn certmgr_metadata_and_limit_filters_narrow_the_result() {
    let db = Db::connect_memory().await.unwrap();
    let (_, gamma_id, ..) = seed_filter_fixture(&db).await;

    let by_metadata = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                metadata_key: Some("team".into()),
                metadata_value: Some("platform".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(by_metadata.len(), 1);
    assert_eq!(by_metadata[0].id, gamma_id);

    let limited = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                limit: Some(2),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(limited.len(), 2);

    // A wildcard in caller input stays literal rather than matching all.
    let literal = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                common_name_contains: Some("%".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert!(literal.is_empty());
}

#[tokio::test]
async fn certmgr_dashboard_rollup_counts_a_seeded_fixture() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let now = Utc::now();
    let seeds = [
        ("alpha", "active", "ecdsa-p256", "api", 3_i64),
        ("beta", "active", "rsa-2048", "acme", 20),
        ("gamma", "revoked", "ecdsa-p256", "est", 200),
    ];
    for (suffix, status, algorithm, method, days) in seeds {
        db.insert_certificate_issuance_request(&certificate_request(
            "org:one",
            &authority,
            &format!("request:{suffix}"),
            &format!("idem:{suffix}"),
        ))
        .await
        .unwrap();
        let mut certificate = certmgr_managed_certificate(
            "org:one",
            &authority,
            &format!("request:{suffix}"),
            &format!("cert:{suffix}"),
        );
        certificate.status = status.into();
        certificate.key_algorithm = Some(algorithm.into());
        certificate.enrollment_method = Some(method.into());
        certificate.expires_at = (now + Duration::days(days)).to_rfc3339();
        db.insert_managed_certificate(&certificate).await.unwrap();
    }

    let rollup = db.dashboard_rollup("org:one").await.unwrap();
    assert_eq!(rollup.total, 3);
    assert_eq!(rollup.by_status.get("active"), Some(&2));
    assert_eq!(rollup.by_status.get("revoked"), Some(&1));
    assert_eq!(rollup.by_key_algorithm.get("ecdsa-p256"), Some(&2));
    assert_eq!(rollup.by_key_algorithm.get("rsa-2048"), Some(&1));
    assert_eq!(rollup.by_issuing_ca.get(&authority), Some(&3));
    assert_eq!(rollup.by_enrollment_method.get("api"), Some(&1));
    assert_eq!(rollup.expiring_within_7_days, 1);
    assert_eq!(rollup.expiring_within_30_days, 2);
    assert_eq!(rollup.expiring_within_90_days, 2);
    assert_eq!(db.dashboard_rollup("org:two").await.unwrap().total, 0);
}

#[tokio::test]
async fn certmgr_expiring_helper_matches_the_legacy_shape() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    seed_certificate(&db, "org:one", &authority, "alpha").await;
    assert_eq!(
        db.list_certificates_expiring_before("org:one", "2027-01-01T00:00:00+00:00")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .list_certificates_expiring_before("org:two", "2027-01-01T00:00:00+00:00")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn certmgr_metadata_documents_are_bounded_and_scalar() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
    for rejected in [
        "[]".to_string(),
        r#"{"nested":{"a":1}}"#.to_string(),
        format!(r#"{{"big":"{}"}}"#, "x".repeat(20_000)),
        "not json".to_string(),
    ] {
        assert!(db
            .set_certificate_metadata("org:one", &certificate.id, &rejected)
            .await
            .is_err());
    }
    assert!(db
        .set_certificate_metadata("org:one", &certificate.id, r#"{"team":"platform"}"#)
        .await
        .unwrap());
}

#[tokio::test]
async fn certmgr_unknown_certificate_status_is_rejected_in_rust() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    db.insert_certificate_issuance_request(&certificate_request(
        "org:one",
        &authority,
        "request:bogus",
        "idem:bogus",
    ))
    .await
    .unwrap();
    let mut certificate =
        certmgr_managed_certificate("org:one", &authority, "request:bogus", "cert:bogus");
    certificate.status = "compromised".into();
    assert!(db.insert_managed_certificate(&certificate).await.is_err());
}

#[test]
fn certmgr_sealed_carriers_redact_their_debug_output() {
    let material = SealedCertificateMaterial {
        key_id: "seal:v1".into(),
        ciphertext: b"super-secret".to_vec(),
        nonce: b"nonce".to_vec(),
        aad_digest: "sha256:aad".into(),
    };
    let signer = StoredSigner {
        id: "signer:one".into(),
        organization_id: "org:one".into(),
        name: "release".into(),
        certificate_id: None,
        key_source: "sealed".into(),
        hsm_connector_id: None,
        hsm_key_label: None,
        status: "active".into(),
        auto_renew: false,
        renew_before_seconds: None,
        sealed_key: Some(material.clone()),
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    let key = StoredManagedCertificateKey {
        id: "key:one".into(),
        organization_id: "org:one".into(),
        certificate_id: "cert:one".into(),
        sealed_key: material,
        version: 1,
        created_at: CERTMGR_NOW.into(),
        updated_at: CERTMGR_NOW.into(),
    };
    for rendered in [format!("{signer:?}"), format!("{key:?}")] {
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("115"));
    }
}

#[test]
fn certmgr_role_ladder_maps_both_spellings() {
    assert_eq!(Role::from_application_str("admin"), Some(Role::Admin));
    assert_eq!(Role::from_signer_str("administrator"), Some(Role::Admin));
    assert_eq!(Role::from_application_str("administrator"), None);
    assert_eq!(Role::from_signer_str("admin"), None);
    assert!(Role::Admin > Role::Operator && Role::Operator > Role::Auditor);
    assert_eq!(Role::Admin.as_application_str(), "admin");
    assert_eq!(Role::Admin.as_signer_str(), "administrator");
}

#[test]
fn certmgr_filter_clamps_and_escapes_caller_patterns() {
    let long = "\u{00e9}".repeat(MAX_FILTER_PATTERN_LEN * 2);
    let query = CertificateFilter {
        common_name_contains: Some(long.clone()),
        san_contains: Some(long.clone()),
        metadata_key: Some(long.clone()),
        metadata_value: Some(long),
        ..CertificateFilter::default()
    }
    .to_query();
    // Clamped at a character boundary, so multi-byte input cannot split a
    // code point; each pattern is still exactly one bound parameter.
    assert_eq!(query.text_binds.len(), 4);
    for (index, bound) in query.text_binds.iter().enumerate() {
        let expected = if index < 2 {
            // The two LIKE patterns carry the leading and trailing wildcard.
            MAX_FILTER_PATTERN_LEN + 2
        } else {
            MAX_FILTER_PATTERN_LEN
        };
        assert_eq!(bound.chars().count(), expected);
    }

    // LIKE metacharacters are escaped, so `%` and `_` match literally.
    let escaped = CertificateFilter {
        common_name_contains: Some("100%_x".into()),
        ..CertificateFilter::default()
    }
    .to_query();
    assert_eq!(escaped.text_binds, vec![r"%100\%\_x%".to_string()]);
    assert_eq!(escaped.sql.matches("ESCAPE '\\'").count(), 1);
    assert_eq!(escaped.sql.matches('?').count(), 2);
}

#[tokio::test]
async fn certmgr_escaped_wildcards_match_literally_not_everything() {
    let db = Db::connect_memory().await.unwrap();
    let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
    seed_certificate(&db, "org:one", &authority, "alpha").await;
    // Without an ESCAPE clause this pattern would match every row.
    let matched = db
        .list_certificates(
            "org:one",
            &CertificateFilter {
                common_name_contains: Some("%".into()),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap();
    assert!(matched.is_empty());

    // A 100k-character subject is stored verbatim; only the pattern clamps.
    let long_cn = "x".repeat(100_000);
    db.insert_certificate_issuance_request(&certificate_request(
        "org:one",
        &authority,
        "request:long",
        "idem:long",
    ))
    .await
    .unwrap();
    let mut long = certmgr_managed_certificate("org:one", &authority, "request:long", "cert:long");
    long.common_name.clone_from(&long_cn);
    db.insert_managed_certificate(&long).await.unwrap();
    assert_eq!(
        db.get_certificate("org:one", "cert:long")
            .await
            .unwrap()
            .unwrap()
            .common_name
            .len(),
        100_000
    );
    assert_eq!(
        db.list_certificates(
            "org:one",
            &CertificateFilter {
                common_name_contains: Some(long_cn),
                ..CertificateFilter::default()
            },
        )
        .await
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn certmgr_filter_only_ever_emits_bind_placeholders() {
    let filter = CertificateFilter {
        status: Some("'; DROP TABLE issued_certificates; --".into()),
        common_name_contains: Some("100% _wild".into()),
        san_contains: Some("\\".into()),
        profile_id: Some("profile:one".into()),
        application_id: Some("app:one".into()),
        expiring_before: Some("2027-01-01T00:00:00+00:00".into()),
        metadata_key: Some("team".into()),
        metadata_value: Some("platform".into()),
        limit: Some(10_000),
    };
    let query = filter.to_query();
    assert_eq!(query.text_binds.len(), 8);
    assert_eq!(query.limit, Some(CERTIFICATE_LIST_MAX_LIMIT));
    assert!(!query.sql.contains("DROP TABLE"));
    for value in &query.text_binds {
        assert!(!query.sql.contains(value.as_str()));
    }
    // The only quoted literals in the statement are the two LIKE escapes.
    assert_eq!(query.sql.matches("ESCAPE '\\'").count(), 2);
    assert_eq!(query.sql.matches('\'').count(), 4);
    assert_eq!(query.sql.matches('?').count(), 10);
}
