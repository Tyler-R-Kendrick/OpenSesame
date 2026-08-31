//! Cross-layer pacts for the Certificate Manager storage schema.
//!
//! These pin contracts that no single layer owns: the enum spellings the PKI
//! engine will serialize against the DDL's CHECK constraints, the seal-scope
//! constants that key every AAD, and the append-only `MIGRATIONS` ordering.
//! A pact break here means two layers have silently diverged — for the seal
//! scopes, that would mean previously sealed data can no longer be opened.

mod support;

use opensesame_storage::{migration_versions, seal_scopes, Db, CERTIFICATE_STATUSES};
use support::{seed_org, ORG_ONE};

/// Insert one row through raw SQL to prove a CHECK accepts (or rejects) a
/// value, without needing the accessor for that table.
async fn check_accepts(db: &Db, sql: &str, value: &str) -> bool {
    sqlx::query(sql)
        .bind(value)
        .execute(db.pool())
        .await
        .is_ok()
}

#[tokio::test]
async fn pact_key_algorithm_spellings_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    seed_org(&db, ORG_ONE, "one").await;
    let sql =
        "UPDATE certificate_authorities SET key_algorithm = ? WHERE organization_id = 'org:one'";
    for legal in [
        "rsa-2048",
        "rsa-4096",
        "ecdsa-p256",
        "ecdsa-p384",
        "ed25519",
    ] {
        assert!(
            check_accepts(&db, sql, legal).await,
            "schema rejected the PKI engine spelling {legal}"
        );
    }
    assert!(!check_accepts(&db, sql, "ECDSA_P256").await);
    assert!(!check_accepts(&db, sql, "rsa2048").await);
}

#[tokio::test]
async fn pact_authority_kind_and_key_source_spellings_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    seed_org(&db, ORG_ONE, "one").await;
    let kind_sql = "UPDATE certificate_authorities SET kind = ? WHERE organization_id = 'org:one'";
    for legal in ["root", "intermediate"] {
        assert!(check_accepts(&db, kind_sql, legal).await);
    }
    assert!(!check_accepts(&db, kind_sql, "subordinate").await);

    let source_sql =
        "UPDATE certificate_authorities SET key_source = ? WHERE organization_id = 'org:one'";
    for legal in ["sealed", "hsm"] {
        assert!(check_accepts(&db, source_sql, legal).await);
    }
    assert!(!check_accepts(&db, source_sql, "pkcs11").await);
}

#[tokio::test]
async fn pact_inventory_source_and_enrollment_method_spellings_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, ..) = seed_org(&db, ORG_ONE, "one").await;
    support::seed_certificate(&db, ORG_ONE, &authority, "alpha").await;

    let source_sql = "UPDATE issued_certificates SET source = ? WHERE organization_id = 'org:one'";
    for legal in ["issued", "imported", "discovered"] {
        assert!(check_accepts(&db, source_sql, legal).await);
    }
    assert!(!check_accepts(&db, source_sql, "scanned").await);

    let method_sql =
        "UPDATE issued_certificates SET enrollment_method = ? WHERE organization_id = 'org:one'";
    for legal in ["api", "acme", "est", "scep", "ui", "import"] {
        assert!(check_accepts(&db, method_sql, legal).await);
    }
    assert!(!check_accepts(&db, method_sql, "cmp").await);
}

#[tokio::test]
async fn pact_policy_presets_and_profile_issuer_types_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    seed_org(&db, ORG_ONE, "one").await;
    let preset_sql = "UPDATE certificate_policies SET preset = ? WHERE organization_id = 'org:one'";
    for legal in [
        "tls_server",
        "tls_client",
        "code_signing",
        "device",
        "user",
        "email_protection",
        "dual_purpose_server",
        "intermediate_ca",
        "custom",
    ] {
        assert!(check_accepts(&db, preset_sql, legal).await);
    }
    assert!(!check_accepts(&db, preset_sql, "server_tls").await);

    let issuer_sql =
        "UPDATE certificate_profiles SET issuer_type = ? WHERE organization_id = 'org:one'";
    assert!(check_accepts(&db, issuer_sql, "ca").await);
    assert!(!check_accepts(&db, issuer_sql, "external").await);
}

#[tokio::test]
async fn pact_external_ca_kinds_and_trust_classes_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    seed_org(&db, ORG_ONE, "one").await;
    let insert = "INSERT INTO external_ca_configs (id, organization_id, kind, connection_id, config_json, trust_class, auto_renew, renew_before_seconds, version, created_at, updated_at) \
                  VALUES (?, 'org:one', ?, 'connection:one', '{}', 'private_local', 0, NULL, 1, '2026-08-30T00:00:00+00:00', '2026-08-30T00:00:00+00:00')";
    for (index, legal) in [
        "aws_pca",
        "digicert_acme",
        "digicert_direct",
        "sectigo",
        "godaddy",
        "azure_adcs",
        "venafi_cloud",
        "private_acme",
    ]
    .into_iter()
    .enumerate()
    {
        let inserted = sqlx::query(insert)
            .bind(format!("external:{index}"))
            .bind(legal)
            .execute(db.pool())
            .await;
        assert!(inserted.is_ok(), "schema rejected external CA kind {legal}");
    }
    assert!(sqlx::query(insert)
        .bind("external:bogus")
        .bind("lets_encrypt")
        .execute(db.pool())
        .await
        .is_err());

    let trust_sql =
        "UPDATE external_ca_configs SET trust_class = ? WHERE organization_id = 'org:one'";
    for legal in ["public_web", "private_local", "origin_only", "test_only"] {
        assert!(check_accepts(&db, trust_sql, legal).await);
    }
    assert!(!check_accepts(&db, trust_sql, "internal").await);
}

#[tokio::test]
async fn pact_membership_role_spellings_match_the_schema() {
    let db = Db::connect_memory().await.expect("migrate");
    let (_, _, _, application_id) = seed_org(&db, ORG_ONE, "one").await;
    db.insert_signer(&support::signer(ORG_ONE, "signer:one"))
        .await
        .expect("signer");

    let app_insert = "INSERT INTO pki_application_members (id, organization_id, application_id, subject, role, version, created_at, updated_at) \
                      VALUES (?, 'org:one', ?, 'principal:ada', ?, 1, '2026-08-30T00:00:00+00:00', '2026-08-30T00:00:00+00:00')";
    for (index, legal) in ["admin", "operator", "auditor"].into_iter().enumerate() {
        assert!(sqlx::query(app_insert)
            .bind(format!("member:{index}"))
            .bind(&application_id)
            .bind(legal)
            .execute(db.pool())
            .await
            .is_ok());
        sqlx::query("DELETE FROM pki_application_members")
            .execute(db.pool())
            .await
            .expect("reset");
    }
    // Applications never use the signer spelling and vice versa.
    assert!(sqlx::query(app_insert)
        .bind("member:bogus")
        .bind(&application_id)
        .bind("administrator")
        .execute(db.pool())
        .await
        .is_err());

    let signer_insert = "INSERT INTO signer_members (id, organization_id, signer_id, subject, role, version, created_at, updated_at) \
                         VALUES (?, 'org:one', 'signer:one', 'principal:ada', ?, 1, '2026-08-30T00:00:00+00:00', '2026-08-30T00:00:00+00:00')";
    assert!(sqlx::query(signer_insert)
        .bind("signer-member:one")
        .bind("administrator")
        .execute(db.pool())
        .await
        .is_ok());
    assert!(sqlx::query(signer_insert)
        .bind("signer-member:bogus")
        .bind("admin")
        .execute(db.pool())
        .await
        .is_err());
}

#[test]
fn pact_seal_scopes_are_exactly_the_documented_set() {
    // A renamed scope changes the AAD and silently breaks decryption of data
    // sealed under the old name, so this set is frozen by contract (§4.5).
    let scopes = [
        seal_scopes::MANAGED_LEAF_KEY,
        seal_scopes::ENROLLMENT_SECRET,
        seal_scopes::EAB_SECRET,
        seal_scopes::EST_PASSPHRASE,
        seal_scopes::SCEP_STATIC_SECRET,
        seal_scopes::SIGNER_KEY,
        seal_scopes::HSM_PIN,
        seal_scopes::EXTERNAL_CA_CREDENTIAL,
        seal_scopes::CRL_DER,
        seal_scopes::ACME_ACCOUNT_KEY,
    ];
    assert_eq!(
        scopes,
        [
            "managed_leaf_key",
            "enrollment_secret",
            "eab_secret",
            "est_passphrase",
            "scep_static_secret",
            "signer_key",
            "hsm_pin",
            "external_ca_credential",
            "crl_der",
            "acme_account_key",
        ]
    );
    let mut unique = scopes.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), scopes.len(), "seal scopes must be distinct");
}

#[test]
fn pact_certificate_statuses_are_the_documented_set() {
    assert_eq!(
        CERTIFICATE_STATUSES,
        &["active", "renewed", "revoked", "expired", "pending"]
    );
}

#[test]
fn pact_migrations_are_append_only_and_end_with_0020() {
    let versions = migration_versions();
    assert_eq!(
        versions,
        vec![
            "0001_init",
            "0002_connections",
            "0003_connection_owner",
            "0004_integrations",
            "0005_credential_generation",
            "0006_provider_configuration",
            "0007_provider_connections",
            "0008_backup_outbox",
            "0009_host_kv",
            "0010_connection_materialization",
            "0011_attachment_targets",
            "0012_connection_delegations",
            "0013_certificate_issuance",
            "0014_custom_providers",
            "0015_backup_target_kinds",
            "0016_certificate_manager",
            "0017_lifecycle_hooks",
            "0018_rotation_leases",
            "0019_web_login_observation",
            "0020_rotation_policy_owner",
        ]
    );
    assert_eq!(versions.last().copied(), Some("0020_rotation_policy_owner"));
}
