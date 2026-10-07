use super::*;
use chrono::Duration;
use opensesame_human_vault::credential_canaries::{reference, ArtifactKind, Phase};

async fn fixture() -> (Db, HostCanaryBinding, ConnectionId, String) {
    let db = Db::connect_memory().await.unwrap();
    let org = OrganizationId::new();
    let target = ConnectionId::new();
    let now = Utc::now();
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) VALUES(?,?,?,?,'policy-target','active','[]','[]','human','private',1,'{}',?,?)")
      .bind(target.as_uuid().to_string()).bind(org.to_string()).bind("controlled-test").bind("test-target").bind(timestamp(now)).bind(timestamp(now)).execute(db.pool()).await.unwrap();
    let binding = HostCanaryBinding {
        organization_id: org,
        tomb: "personal".into(),
        vault_identity: "trusted-public-test-vault".into(),
    };
    let mut registry = Registry::new(&binding.tomb, &binding.vault_identity);
    let created = registry
        .create(ArtifactKind::ConnectionRef, &timestamp(now))
        .unwrap();
    db.register_controlled_canary(&binding, &registry.artifacts[0])
        .await
        .unwrap();
    (
        db,
        binding,
        target,
        reference(&created.presented_id).unwrap(),
    )
}
#[tokio::test]
async fn credential_canaries_actual_alias_lifecycle_is_atomic_and_value_blind() {
    let (db, binding, target, bait) = fixture().await;
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &bait)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    let alias = db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &target,
            &timestamp(Utc::now() + Duration::minutes(5)),
        )
        .await
        .unwrap();
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::ActiveAlias {
            connection_id: target,
            target_reference: target.as_uuid().to_string(),
        }
    );
    assert_eq!(
        db.classify_controlled_reference(&OrganizationId::new(), &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    let artifact = db
        .retire_controlled_alias(&binding.organization_id, &alias.issuer_record_ref)
        .await
        .unwrap();
    assert_eq!(artifact.state, ArtifactState::Retired);
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    let status = db
        .controlled_canary_status(&binding.organization_id, &binding.tomb)
        .await
        .unwrap();
    assert!(status
        .events
        .iter()
        .any(|e| e.phase == Phase::RetiredGenerationObserved));
    let raw: String = sqlx::query_scalar("SELECT registry_json FROM host_canary_registries")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert!(!raw.contains(alias.reference.strip_prefix("osissued:v1:").unwrap()));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM host_controlled_aliases WHERE retired_at IS NOT NULL",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn credential_canaries_expiry_and_unknown_prefix_fail_closed() {
    let (db, binding, target, _) = fixture().await;
    let alias = db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &target,
            &timestamp(Utc::now() + Duration::minutes(1)),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE host_controlled_aliases SET expires_at=? WHERE id=?")
        .bind(timestamp(Utc::now() - Duration::seconds(1)))
        .bind(&alias.issuer_record_ref)
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    for value in [
        "oscanary:v1:bad",
        "osissued:v2:bad",
        "osissued:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        assert_eq!(
            db.classify_controlled_reference(&binding.organization_id, value)
                .await
                .unwrap(),
            ControlledReferenceDecision::Reject
        );
    }
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, "original-production-reference")
            .await
            .unwrap(),
        ControlledReferenceDecision::Ordinary
    );
    assert!(db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &ConnectionId::new(),
            &timestamp(Utc::now() + Duration::minutes(1))
        )
        .await
        .is_err());
}
#[tokio::test]
async fn credential_canaries_retirement_capacity_is_reserved_at_issue() {
    let (db, binding, target, _) = fixture().await;
    let mut created = Registry::new(&binding.tomb, &binding.vault_identity);
    for _ in 0..14 {
        created
            .create(ArtifactKind::ConnectionRef, &timestamp(Utc::now()))
            .unwrap();
        db.register_controlled_canary(&binding, created.artifacts.last().unwrap())
            .await
            .unwrap();
    }
    let alias = db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &target,
            &timestamp(Utc::now() + Duration::minutes(1)),
        )
        .await
        .unwrap();
    assert!(db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &target,
            &timestamp(Utc::now() + Duration::minutes(1))
        )
        .await
        .is_err());
    db.retire_controlled_alias(&binding.organization_id, &alias.issuer_record_ref)
        .await
        .unwrap();
    assert_eq!(
        db.controlled_canary_status(&binding.organization_id, &binding.tomb)
            .await
            .unwrap()
            .artifacts
            .len(),
        16
    );
}

#[tokio::test]
async fn credential_canaries_issuer_collision_refused_and_generations_survive_removal() {
    let (db, binding, target, _) = fixture().await;
    let expiry = timestamp(Utc::now() + Duration::minutes(1));
    let alias = db
        .issue_controlled_alias(&binding.organization_id, &binding.tomb, &target, &expiry)
        .await
        .unwrap();
    let mut bait = db
        .controlled_canary_status(&binding.organization_id, &binding.tomb)
        .await
        .unwrap()
        .artifacts[0]
        .clone();
    bait.id = alias.issuer_record_ref.clone();
    assert!(db
        .register_controlled_canary(&binding, &bait)
        .await
        .is_err());
    let retired = db
        .retire_controlled_alias(&binding.organization_id, &alias.issuer_record_ref)
        .await
        .unwrap();
    db.retire_controlled_alias(&binding.organization_id, &alias.issuer_record_ref)
        .await
        .unwrap();
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    db.remove_controlled_canary(&binding.organization_id, &binding.tomb, &retired.id)
        .await
        .unwrap();
    let next = db
        .issue_controlled_alias(&binding.organization_id, &binding.tomb, &target, &expiry)
        .await
        .unwrap();
    assert!(next.context.generation > alias.context.generation);
}

#[tokio::test]
async fn credential_canaries_independent_database_handles_serialize_issuer_generations() {
    let path = std::env::temp_dir().join(format!(
        "opensesame-controlled-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let url = format!("sqlite:{}?mode=rwc", path.display());
    let (db, binding, target, _) = fixture().await;
    let first = Db::connect_sqlite(&url).await.unwrap();
    let second = Db::connect_sqlite(&url).await.unwrap();
    let original = db
        .controlled_canary_status(&binding.organization_id, &binding.tomb)
        .await
        .unwrap();
    first
        .register_controlled_canary(&binding, &original.artifacts[0])
        .await
        .unwrap();
    let row = sqlx::query("SELECT * FROM connections WHERE id=?")
        .bind(target.as_uuid().to_string())
        .fetch_one(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) VALUES(?,?,?,?,'policy-target','active','[]','[]','human','private',1,'{}',?,?)").bind(target.as_uuid().to_string()).bind(binding.organization_id.to_string()).bind(row.get::<String,_>("provider_id")).bind("copied-test-target").bind(timestamp(Utc::now())).bind(timestamp(Utc::now())).execute(first.pool()).await.unwrap();
    let expiry = timestamp(Utc::now() + Duration::minutes(1));
    let (a, b) = tokio::join!(
        first.issue_controlled_alias(&binding.organization_id, &binding.tomb, &target, &expiry),
        second.issue_controlled_alias(&binding.organization_id, &binding.tomb, &target, &expiry)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a.context.generation, b.context.generation);
    second
        .retire_controlled_alias(&binding.organization_id, &a.issuer_record_ref)
        .await
        .unwrap();
    assert_eq!(
        first
            .classify_controlled_reference(&binding.organization_id, &a.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    first.pool().close().await;
    second.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn credential_canaries_ambiguous_target_spelling_refuses_issue() {
    let (db, binding, target, _) = fixture().await;
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) SELECT ?,organization_id,provider_id,'ambiguous-target',display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at FROM connections WHERE id=?").bind(target.to_string()).bind(target.as_uuid().to_string()).execute(db.pool()).await.unwrap();
    assert!(db
        .issue_controlled_alias(
            &binding.organization_id,
            &binding.tomb,
            &target,
            &timestamp(Utc::now() + Duration::minutes(1))
        )
        .await
        .is_err());
}
