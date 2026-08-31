//! Host-custody certificate issuance and renewal (ADR 0075).
//!
//! The Certificate Manager's schema has always had the two tables this needs —
//! `issued_certificates` with its `auto_renew_enabled` / `renewed_from_id`
//! columns, and `managed_certificate_keys` — but nothing ever wrote them
//! together. These methods are the writers, and the reason they live here
//! rather than beside the delivery path is the invariant they enforce:
//!
//! **A managed certificate and its sealed private key are created in one
//! transaction, or neither exists.** A certificate row without its key is
//! unrenewable *and* undeployable — the host could neither reissue it nor hand
//! it to anyone — so a half-written pair is worse than no pair at all.
//!
//! [`Db::complete_certificate_issuance`] cannot serve this: it writes the
//! 0013-era column set and requires a time-boxed delivery blob, which is the
//! opposite custody model. `transition_certificate_issuance` refuses
//! `completed` outright, so completion has to be its own transaction either
//! way.

use anyhow::Context;
use chrono::Utc;

use crate::{
    validate_certificate_status, validate_json_document, validate_san_json,
    validate_sealed_material, Db, StoredManagedCertificate, StoredManagedCertificateKey,
};

// Custody is deliberately *not* recorded as a label on the certificate row.
// `issued_certificates.source` is a closed CHECK over how a certificate was
// obtained (`issued` / `imported` / `discovered`), which is a different
// question from who holds its key — and a label can drift from reality in a
// way the fact cannot. "Does the host hold this key?" is answered by whether
// `managed_certificate_keys` has a row, which is the same thing the renewal
// path needs to be true before it can reissue anything.

impl Db {
    /// Atomically complete a host-custody issuance: settle the request, record
    /// the certificate, and seal away its private key.
    ///
    /// Returns `false` when the request row moved underneath us — a stale
    /// version, an unexpected state, or an expired request — leaving nothing
    /// written, exactly like [`Db::complete_certificate_issuance`].
    ///
    /// # Errors
    ///
    /// Returns an error when the SAN or metadata documents are malformed, the
    /// status is unknown, the sealed key is incomplete, the certificate and key
    /// disagree about which certificate they belong to, or the transaction
    /// fails.
    pub async fn complete_managed_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        certificate: &StoredManagedCertificate,
        sealed_key: &StoredManagedCertificateKey,
    ) -> anyhow::Result<bool> {
        validate_san_json(&certificate.san_json)?;
        validate_json_document(&certificate.metadata_json, "certificate metadata")?;
        validate_certificate_status(&certificate.status)?;
        validate_sealed_material(&sealed_key.sealed_key)?;
        if certificate.organization_id != organization_id || certificate.request_id != request_id {
            anyhow::bail!("managed certificate ownership does not match request");
        }
        if sealed_key.organization_id != organization_id
            || sealed_key.certificate_id != certificate.id
        {
            anyhow::bail!("managed key does not belong to the certificate it completes");
        }

        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        // The request is settled under the same optimistic guard the delivery
        // path uses, including the expiry check: a request that timed out must
        // not be able to mint a certificate afterwards.
        let settled = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = 'completed', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND authority_id = ? AND common_name = ? AND san_json = ? \
               AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(request_id)
        .bind(&certificate.authority_id)
        .bind(&certificate.common_name)
        .bind(&certificate.san_json)
        .bind(expected_version)
        .bind(expected_state)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .context("settle managed certificate issuance request")?;
        if settled.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }

        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, application_id, profile_id, source, enrollment_method, metadata_json, key_algorithm, signature_algorithm, fingerprint_sha256, chain_pem, renewed_from_id, renewed_by_id, auto_renew_enabled, renew_before_seconds, revocation_reason, revoked_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&certificate.id)
        .bind(&certificate.organization_id)
        .bind(&certificate.authority_id)
        .bind(&certificate.request_id)
        .bind(&certificate.certificate_digest)
        .bind(&certificate.serial_number)
        .bind(&certificate.common_name)
        .bind(&certificate.san_json)
        .bind(&certificate.not_before)
        .bind(&certificate.expires_at)
        .bind(&certificate.status)
        .bind(&certificate.application_id)
        .bind(&certificate.profile_id)
        .bind(&certificate.source)
        .bind(&certificate.enrollment_method)
        .bind(&certificate.metadata_json)
        .bind(&certificate.key_algorithm)
        .bind(&certificate.signature_algorithm)
        .bind(&certificate.fingerprint_sha256)
        .bind(&certificate.chain_pem)
        .bind(&certificate.renewed_from_id)
        .bind(&certificate.renewed_by_id)
        .bind(i64::from(certificate.auto_renew_enabled))
        .bind(certificate.renew_before_seconds)
        .bind(certificate.revocation_reason)
        .bind(&certificate.revoked_at)
        .bind(certificate.version.max(1))
        .bind(&certificate.created_at)
        .bind(&certificate.updated_at)
        .execute(&mut *transaction)
        .await
        .context("insert managed certificate")?;

        sqlx::query(
            "INSERT INTO managed_certificate_keys (id, organization_id, certificate_id, sealed_key_key_id, sealed_key_ciphertext, sealed_key_nonce, sealed_key_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&sealed_key.id)
        .bind(&sealed_key.organization_id)
        .bind(&sealed_key.certificate_id)
        .bind(&sealed_key.sealed_key.key_id)
        .bind(&sealed_key.sealed_key.ciphertext)
        .bind(&sealed_key.sealed_key.nonce)
        .bind(&sealed_key.sealed_key.aad_digest)
        .bind(sealed_key.version.max(1))
        .bind(&sealed_key.created_at)
        .bind(&sealed_key.updated_at)
        .execute(&mut *transaction)
        .await
        .context("seal managed certificate key")?;

        transaction.commit().await?;
        Ok(true)
    }

    /// Retire a certificate its successor has replaced.
    ///
    /// Only an `active` row moves, so a revoked certificate is never quietly
    /// relabelled as merely superseded — the two are different facts and a
    /// reviewer needs them to stay different. The status change also removes
    /// the row from [`Db::list_certificates_expiring_before`], which is what
    /// stops the lifecycle scanner from continuing to warn about a deadline
    /// that no longer matters.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn mark_certificate_renewed(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE issued_certificates SET status = 'renewed', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = 'active'",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(certificate_id)
        .execute(&self.pool)
        .await
        .context("mark certificate renewed")?;
        Ok(result.rows_affected() == 1)
    }
}
