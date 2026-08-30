//! Snapshot (characterization) coverage for the Certificate Manager storage
//! layer (migration 0016, plan §4.1/§4.3).
//!
//! The schema snapshot is the load-bearing one: it pins the DDL that actually
//! lands in an empty database, so any accidental column, CHECK or index drift
//! shows up as a review diff rather than as a runtime surprise. Nothing here
//! renders sealed bytes — sealed fields are projected as presence flags.

mod support;

use opensesame_storage::{CertificateFilter, Db, StoredManagedCertificateKey};
use serde_json::{json, Value};
use sqlx::Row;
use support::{sealed, seed_certificate, seed_org, NOW, ORG_ONE};

/// Collapse SQL whitespace so the snapshot pins structure, not formatting.
fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn schema_objects(db: &Db, kind: &str) -> Vec<(String, String, String)> {
    sqlx::query(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name",
    )
    .bind(kind)
    .fetch_all(db.pool())
    .await
    .expect("sqlite_master")
    .into_iter()
    .map(|row| {
        (
            row.get::<String, _>("name"),
            row.get::<String, _>("tbl_name"),
            normalize(&row.get::<String, _>("sql")),
        )
    })
    .collect()
}

async fn columns(db: &Db, table: &str) -> Vec<Value> {
    sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(db.pool())
        .await
        .expect("table_info")
        .into_iter()
        .map(|row| {
            json!({
                "name": row.get::<String, _>("name"),
                "type": row.get::<String, _>("type"),
                "not_null": row.get::<i64, _>("notnull") == 1,
                "default": row.get::<Option<String>, _>("dflt_value"),
                "primary_key": row.get::<i64, _>("pk") == 1,
            })
        })
        .collect()
}

#[tokio::test]
async fn snapshot_certificate_manager_schema_shape() {
    let db = Db::connect_memory().await.expect("migrate");
    let new_tables: Vec<Value> = schema_objects(&db, "table")
        .await
        .into_iter()
        .filter(|(name, _, _)| support::CERTMGR_TABLES.contains(&name.as_str()))
        .map(|(name, _, sql)| json!({ "table": name, "ddl": sql }))
        .collect();
    assert_eq!(new_tables.len(), support::CERTMGR_TABLES.len());

    let new_indexes: Vec<Value> = schema_objects(&db, "index")
        .await
        .into_iter()
        .filter(|(name, table, _)| {
            support::CERTMGR_TABLES.contains(&table.as_str())
                || name.starts_with("idx_issued_certificates_")
        })
        .map(|(name, table, sql)| json!({ "index": name, "table": table, "ddl": sql }))
        .collect();

    insta::assert_json_snapshot!(json!({
        "migration": "0016_certificate_manager",
        "tables": new_tables,
        "indexes": new_indexes,
        "extended_certificate_authorities": columns(&db, "certificate_authorities").await,
        "extended_issued_certificates": columns(&db, "issued_certificates").await,
    }));
}

#[tokio::test]
async fn snapshot_row_group_projections() {
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, policy_id, profile_id, application_id) = seed_org(&db, ORG_ONE, "one").await;
    let certificate = seed_certificate(&db, ORG_ONE, &authority, "alpha").await;
    db.insert_managed_certificate_key(&StoredManagedCertificateKey {
        id: "key:alpha".into(),
        organization_id: ORG_ONE.into(),
        certificate_id: certificate.id.clone(),
        sealed_key: sealed("leaf"),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    })
    .await
    .expect("managed key");
    db.insert_signer(&support::signer(ORG_ONE, "signer:one"))
        .await
        .expect("signer");

    let policy = db
        .get_certificate_policy(ORG_ONE, &policy_id)
        .await
        .expect("policy")
        .expect("present");
    let profile = db
        .get_certificate_profile(ORG_ONE, &profile_id)
        .await
        .expect("profile")
        .expect("present");
    let app = db
        .get_pki_application(ORG_ONE, &application_id)
        .await
        .expect("application")
        .expect("present");
    let stored_certificate = db
        .get_certificate(ORG_ONE, &certificate.id)
        .await
        .expect("certificate")
        .expect("present");
    let managed_key = db
        .get_managed_certificate_key(ORG_ONE, &certificate.id)
        .await
        .expect("managed key")
        .expect("present");
    let stored_signer = db
        .get_signer(ORG_ONE, "signer:one")
        .await
        .expect("signer")
        .expect("present");

    // Sealed groups are projected as presence, never as bytes.
    insta::assert_json_snapshot!(json!({
        "policy": {
            "preset": policy.preset,
            "max_validity_seconds": policy.max_validity_seconds,
            "rules_json": policy.rules_json,
            "version": policy.version,
        },
        "profile": {
            "issuer_type": profile.issuer_type,
            "has_authority": profile.certificate_authority_id.is_some(),
            "defaults_json": profile.defaults_json,
        },
        "application": { "slug": app.slug, "display_name": app.display_name },
        "certificate": {
            "status": stored_certificate.status,
            "source": stored_certificate.source,
            "enrollment_method": stored_certificate.enrollment_method,
            "key_algorithm": stored_certificate.key_algorithm,
            "signature_algorithm": stored_certificate.signature_algorithm,
            "metadata_json": stored_certificate.metadata_json,
            "auto_renew_enabled": stored_certificate.auto_renew_enabled,
        },
        "managed_key": { "sealed_key_present": !managed_key.sealed_key.key_id.is_empty() },
        "signer": {
            "key_source": stored_signer.key_source,
            "status": stored_signer.status,
            "sealed_key_present": stored_signer.sealed_key.is_some(),
        },
    }));
}

#[tokio::test]
async fn snapshot_dashboard_rollup_for_a_fixed_fixture() {
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, ..) = seed_org(&db, ORG_ONE, "one").await;
    let now = chrono::Utc::now();
    for (suffix, status, algorithm, method, days) in [
        ("alpha", "active", "ecdsa-p256", "api", 3_i64),
        ("beta", "active", "rsa-2048", "acme", 20),
        ("gamma", "revoked", "ecdsa-p256", "est", 200),
    ] {
        db.insert_certificate_issuance_request(&support::issuance_request(
            ORG_ONE,
            &authority,
            &format!("request:{suffix}"),
        ))
        .await
        .expect("request");
        let mut record = support::certificate(
            ORG_ONE,
            &authority,
            &format!("request:{suffix}"),
            &format!("cert:{suffix}"),
        );
        record.status = status.into();
        record.key_algorithm = Some(algorithm.into());
        record.enrollment_method = Some(method.into());
        record.expires_at = (now + chrono::Duration::days(days)).to_rfc3339();
        db.insert_managed_certificate(&record)
            .await
            .expect("certificate");
    }

    let rollup = db.dashboard_rollup(ORG_ONE).await.expect("rollup");
    insta::assert_json_snapshot!(json!({
        "total": rollup.total,
        "by_status": rollup.by_status,
        "by_key_algorithm": rollup.by_key_algorithm,
        "by_issuing_ca": rollup.by_issuing_ca,
        "by_enrollment_method": rollup.by_enrollment_method,
        "expiring_within_7_days": rollup.expiring_within_7_days,
        "expiring_within_30_days": rollup.expiring_within_30_days,
        "expiring_within_90_days": rollup.expiring_within_90_days,
    }));
}

#[test]
fn snapshot_certificate_filter_generates_only_parameterized_sql() {
    let empty = CertificateFilter::default().to_query();
    let full = CertificateFilter {
        status: Some("active".into()),
        common_name_contains: Some("alpha".into()),
        san_contains: Some("alpha.example".into()),
        profile_id: Some("profile:one".into()),
        application_id: Some("app:one".into()),
        expiring_before: Some("2027-01-01T00:00:00+00:00".into()),
        metadata_key: Some("team".into()),
        metadata_value: Some("platform".into()),
        limit: Some(50),
    }
    .to_query();
    // Pinning the SQL text is what proves the filter never interpolates: any
    // caller value appearing here would be an immediately visible diff.
    insta::assert_json_snapshot!(json!({
        "empty_filter_sql": empty.sql,
        "empty_filter_binds": empty.text_binds,
        "full_filter_sql": full.sql,
        "full_filter_bind_count": full.text_binds.len(),
        "full_filter_limit": full.limit,
    }));
}
