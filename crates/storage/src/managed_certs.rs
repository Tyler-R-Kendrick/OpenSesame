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
    stored_managed_certificate, stored_managed_certificate_key, validate_certificate_status,
    validate_json_document, validate_san_json, validate_sealed_material, Db,
    StoredManagedCertificate, StoredManagedCertificateKey,
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

    /// Record a certificate in the managed inventory.
    ///
    /// The 0013 schema makes `authority_id` and `request_id` NOT NULL foreign
    /// keys, so the caller records the issuance request first; migration 0016
    /// deliberately does not rewrite those applied constraints.
    ///
    /// # Errors
    ///
    /// Returns an error when the SAN or metadata documents are malformed, the
    /// status is not a known value, or the insert violates a database
    /// constraint.
    pub async fn insert_managed_certificate(
        &self,
        certificate: &StoredManagedCertificate,
    ) -> anyhow::Result<()> {
        validate_san_json(&certificate.san_json)?;
        validate_json_document(&certificate.metadata_json, "certificate metadata")?;
        validate_certificate_status(&certificate.status)?;
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
        .bind(certificate.version)
        .bind(&certificate.created_at)
        .bind(&certificate.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Place a certificate's managed private key into sealed custody.
    ///
    /// Only the renewal and sync paths call this; no inventory read joins the
    /// table it writes.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed material is incomplete, the
    /// certificate is absent from the organization, or the upsert fails.
    pub async fn insert_managed_certificate_key(
        &self,
        key: &StoredManagedCertificateKey,
    ) -> anyhow::Result<()> {
        validate_sealed_material(&key.sealed_key)?;
        sqlx::query(
            "INSERT INTO managed_certificate_keys (id, organization_id, certificate_id, sealed_key_key_id, sealed_key_ciphertext, sealed_key_nonce, sealed_key_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, certificate_id) DO UPDATE SET \
               sealed_key_key_id = excluded.sealed_key_key_id, sealed_key_ciphertext = excluded.sealed_key_ciphertext, \
               sealed_key_nonce = excluded.sealed_key_nonce, sealed_key_aad_digest = excluded.sealed_key_aad_digest, \
               version = managed_certificate_keys.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&key.id)
        .bind(&key.organization_id)
        .bind(&key.certificate_id)
        .bind(&key.sealed_key.key_id)
        .bind(&key.sealed_key.ciphertext)
        .bind(&key.sealed_key.nonce)
        .bind(&key.sealed_key.aad_digest)
        .bind(key.version)
        .bind(&key.created_at)
        .bind(&key.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read a certificate's sealed managed key.
    ///
    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_managed_certificate_key(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificateKey>> {
        let row = sqlx::query(
            "SELECT * FROM managed_certificate_keys WHERE organization_id = ? AND certificate_id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate_key))
    }

    /// Drop the sealed managed key once it has been delivered or rotated away.
    ///
    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_managed_certificate_key(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM managed_certificate_keys WHERE organization_id = ? AND certificate_id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_renewed_by(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row = sqlx::query(
            "SELECT successor.* FROM issued_certificates AS predecessor \
             JOIN issued_certificates AS successor \
               ON successor.organization_id = predecessor.organization_id \
              AND successor.id = predecessor.renewed_by_id \
             WHERE predecessor.organization_id = ? AND predecessor.id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_renewed_from(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row = sqlx::query(
            "SELECT predecessor.* FROM issued_certificates AS successor \
             JOIN issued_certificates AS predecessor \
               ON predecessor.organization_id = successor.organization_id \
              AND predecessor.id = successor.renewed_from_id \
             WHERE successor.organization_id = ? AND successor.id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }
}
