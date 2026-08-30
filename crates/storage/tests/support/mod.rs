//! Shared Certificate Manager fixtures for the storage integration suites
//! (ADR 0052 custody rules; plan §4.1/§4.3 schema).
//!
//! Every helper seeds through the public `Db` API so the suites exercise the
//! same accessors production code does. No fixture ever carries real key
//! material: sealed blobs are short, obviously synthetic byte strings.
#![allow(dead_code)]

use opensesame_storage::{
    Db, SealedCertificateMaterial, StoredApprovalPolicy, StoredApprovalRequest, StoredApprovalStep,
    StoredCertificateAuthority, StoredCertificateIssuanceRequest, StoredCertificatePolicy,
    StoredCertificateProfile, StoredDiscoveryInstallation, StoredDiscoveryJob,
    StoredManagedCertificate, StoredPkiApplication, StoredSigner, StoredSigningAccessRecord,
};

pub const NOW: &str = "2026-08-30T00:00:00+00:00";
pub const ORG_ONE: &str = "org:one";
pub const ORG_TWO: &str = "org:two";

#[must_use]
pub fn sealed(tag: &str) -> SealedCertificateMaterial {
    SealedCertificateMaterial {
        key_id: format!("seal:{tag}"),
        ciphertext: vec![1, 2, 3, 4],
        nonce: vec![5, 6, 7, 8],
        aad_digest: format!("sha256:{tag}"),
    }
}

#[must_use]
pub fn authority(organization_id: &str, id: &str) -> StoredCertificateAuthority {
    StoredCertificateAuthority {
        id: id.into(),
        organization_id: organization_id.into(),
        issuer_kind: "opensesame_private_ca".into(),
        issuer_connection_id: None,
        display_name: "OpenSesame Private CA".into(),
        public_metadata_json: r#"{"algorithm":"ES256"}"#.into(),
        sealed_material: sealed("authority"),
        is_default: true,
        status: "active".into(),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn issuance_request(
    organization_id: &str,
    authority_id: &str,
    id: &str,
) -> StoredCertificateIssuanceRequest {
    StoredCertificateIssuanceRequest {
        id: id.into(),
        organization_id: organization_id.into(),
        authority_id: authority_id.into(),
        request_digest: format!("sha256:{id}"),
        idempotency_key: format!("idem:{id}"),
        created_by: "principal:owner".into(),
        state: "created".into(),
        common_name: "alpha.example".into(),
        san_json: r#"{"dns_names":["alpha.example"],"ip_addrs":[]}"#.into(),
        delivery: None,
        expires_at: "2099-01-01T00:00:00+00:00".into(),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn policy(organization_id: &str, id: &str) -> StoredCertificatePolicy {
    StoredCertificatePolicy {
        id: id.into(),
        organization_id: organization_id.into(),
        name: format!("policy-{id}"),
        description: Some("TLS server issuance".into()),
        preset: "tls_server".into(),
        max_validity_seconds: Some(7_776_000),
        rules_json: r#"{"subject":{},"san":{}}"#.into(),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn profile(
    organization_id: &str,
    id: &str,
    authority_id: &str,
    policy_id: &str,
) -> StoredCertificateProfile {
    StoredCertificateProfile {
        id: id.into(),
        organization_id: organization_id.into(),
        name: format!("profile-{id}"),
        issuer_type: "ca".into(),
        certificate_authority_id: Some(authority_id.into()),
        policy_id: policy_id.into(),
        defaults_json: r#"{"ttl_seconds":86400}"#.into(),
        external_template: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn application(organization_id: &str, id: &str) -> StoredPkiApplication {
    StoredPkiApplication {
        id: id.into(),
        organization_id: organization_id.into(),
        slug: format!("slug-{id}"),
        display_name: "Edge fleet".into(),
        description: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn certificate(
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
        not_before: NOW.into(),
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
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn signer(organization_id: &str, id: &str) -> StoredSigner {
    StoredSigner {
        id: id.into(),
        organization_id: organization_id.into(),
        name: format!("signer-{id}"),
        certificate_id: None,
        key_source: "sealed".into(),
        hsm_connector_id: None,
        hsm_key_label: None,
        status: "active".into(),
        auto_renew: false,
        renew_before_seconds: None,
        sealed_key: Some(sealed("signer")),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn access_record(
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
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn approval_policy(
    organization_id: &str,
    id: &str,
    application_id: &str,
) -> StoredApprovalPolicy {
    StoredApprovalPolicy {
        id: id.into(),
        organization_id: organization_id.into(),
        scope: "issuance".into(),
        application_id: Some(application_id.into()),
        signer_id: None,
        name: format!("approval-{id}"),
        max_request_ttl_seconds: Some(3600),
        machine_bypass: false,
        covers_json: "[]".into(),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn approval_step(
    organization_id: &str,
    id: &str,
    policy_id: &str,
    seq: i64,
    required_count: i64,
) -> StoredApprovalStep {
    StoredApprovalStep {
        id: id.into(),
        organization_id: organization_id.into(),
        policy_id: policy_id.into(),
        seq,
        name: format!("step-{seq}"),
        approvers_json: r#"["principal:ada","principal:grace"]"#.into(),
        required_count,
        notify: true,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn approval_request(organization_id: &str, id: &str, policy_id: &str) -> StoredApprovalRequest {
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
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn discovery_job(organization_id: &str, id: &str) -> StoredDiscoveryJob {
    StoredDiscoveryJob {
        id: id.into(),
        organization_id: organization_id.into(),
        name: format!("job-{id}"),
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
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[must_use]
pub fn installation(
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
        first_seen_at: NOW.into(),
        last_seen_at: NOW.into(),
        change_log_json: "[]".into(),
        matched_certificate_id: None,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

/// Seed one organization with a CA, policy, profile and application.
/// Returns `(authority_id, policy_id, profile_id, application_id)`.
pub async fn seed_org(
    db: &Db,
    organization_id: &str,
    suffix: &str,
) -> (String, String, String, String) {
    let authority_id = format!("ca:{suffix}");
    let policy_id = format!("policy:{suffix}");
    let profile_id = format!("profile:{suffix}");
    let application_id = format!("app:{suffix}");
    db.insert_certificate_authority(&authority(organization_id, &authority_id))
        .await
        .expect("authority");
    db.insert_certificate_policy(&policy(organization_id, &policy_id))
        .await
        .expect("policy");
    db.insert_certificate_profile(&profile(
        organization_id,
        &profile_id,
        &authority_id,
        &policy_id,
    ))
    .await
    .expect("profile");
    db.insert_pki_application(&application(organization_id, &application_id))
        .await
        .expect("application");
    (authority_id, policy_id, profile_id, application_id)
}

/// Record an issuance request and its inventory row.
pub async fn seed_certificate(
    db: &Db,
    organization_id: &str,
    authority_id: &str,
    suffix: &str,
) -> StoredManagedCertificate {
    let request_id = format!("request:{suffix}");
    db.insert_certificate_issuance_request(&issuance_request(
        organization_id,
        authority_id,
        &request_id,
    ))
    .await
    .expect("issuance request");
    let record = certificate(
        organization_id,
        authority_id,
        &request_id,
        &format!("cert:{suffix}"),
    );
    db.insert_managed_certificate(&record)
        .await
        .expect("certificate");
    record
}

/// Tables migration 0016 creates, in the order the file declares them.
pub const CERTMGR_TABLES: &[&str] = &[
    "acme_challenges",
    "acme_nonces",
    "acme_orders",
    "acme_server_accounts",
    "alert_deliveries",
    "approval_decisions",
    "approval_policies",
    "approval_requests",
    "approval_steps",
    "cert_alerts",
    "cert_syncs",
    "certificate_policies",
    "certificate_profiles",
    "certificate_revocations",
    "crl_state",
    "discovery_installations",
    "discovery_jobs",
    "enrollment_configs",
    "est_configs",
    "external_ca_configs",
    "hsm_connectors",
    "managed_certificate_keys",
    "pki_application_members",
    "pki_applications",
    "scep_challenges",
    "scep_configs",
    "signer_members",
    "signers",
    "signing_access_records",
    "signing_events",
    "sync_runs",
];
