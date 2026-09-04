//! Renewal linkage between an expiring certificate and the one that replaces it.
//!
//! Separate from `managed_certs`, which is about *custody* -- whether the host
//! holds a certificate's private key (ADR 0075). Renewal linkage is a fact
//! about two certificates and holds whether or not either key is in custody.

use anyhow::Context;
use chrono::Utc;

use crate::{now_rfc3339, stored_managed_certificate, Db, StoredManagedCertificate};

impl Db {
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

    /// Link a renewed certificate to its predecessor in both directions.
    ///
    /// # Errors
    ///
    /// Returns an error when either certificate is missing from the
    /// organization or the transaction fails.
    pub async fn insert_renewal_link(
        &self,
        organization_id: &str,
        predecessor_id: &str,
        successor_id: &str,
    ) -> anyhow::Result<()> {
        if predecessor_id == successor_id {
            anyhow::bail!("a certificate cannot renew itself");
        }
        let now = now_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let forward = sqlx::query(
            "UPDATE issued_certificates SET renewed_by_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(successor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(predecessor_id)
        .execute(&mut *transaction)
        .await?;
        let backward = sqlx::query(
            "UPDATE issued_certificates SET renewed_from_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(predecessor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(successor_id)
        .execute(&mut *transaction)
        .await?;
        if forward.rows_affected() != 1 || backward.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("renewal link requires both certificates in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }
}
