//! The issued-certificate inventory and the dashboard rollup computed over it.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_managed_certificate, validate_metadata_document, CertificateFilter,
    DashboardRollup, Db, Row, StoredManagedCertificate, Utc,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row =
            sqlx::query("SELECT * FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }

    /// Inventory search. Every predicate is a bound parameter; no caller value
    /// is ever interpolated into the SQL text.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificates(
        &self,
        organization_id: &str,
        filter: &CertificateFilter,
    ) -> anyhow::Result<Vec<StoredManagedCertificate>> {
        let query = filter.to_query();
        let mut statement = sqlx::query(&query.sql).bind(organization_id);
        for value in &query.text_binds {
            statement = statement.bind(value);
        }
        if let Some(limit) = query.limit {
            statement = statement.bind(limit);
        }
        let rows = statement.fetch_all(&self.pool).await?;
        Ok(rows.iter().map(stored_managed_certificate).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Replace a certificate's non-secret metadata document.
    ///
    /// # Errors
    ///
    /// Returns an error when the document is not a JSON object or the update
    /// fails.
    pub async fn set_certificate_metadata(
        &self,
        organization_id: &str,
        certificate_id: &str,
        metadata_json: &str,
    ) -> anyhow::Result<bool> {
        validate_metadata_document(metadata_json)?;
        let result = sqlx::query(
            "UPDATE issued_certificates SET metadata_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(metadata_json)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(certificate_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_metadata(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let row = sqlx::query(
            "SELECT metadata_json FROM issued_certificates WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.get::<String, _>("metadata_json")))
    }

    /// Certificates expiring at or before `cutoff`, mirroring the 0013 helper.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificates_expiring_before(
        &self,
        organization_id: &str,
        cutoff: &str,
    ) -> anyhow::Result<Vec<StoredManagedCertificate>> {
        let rows = sqlx::query(
            "SELECT * FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?) ORDER BY expires_at, id",
        )
        .bind(organization_id)
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_managed_certificate).collect())
    }

    /// Non-secret counts backing the Certificates dashboard.
    ///
    /// # Errors
    ///
    /// Returns an error when any rollup query fails.
    pub async fn dashboard_rollup(&self, organization_id: &str) -> anyhow::Result<DashboardRollup> {
        let mut rollup = DashboardRollup {
            total: sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM issued_certificates WHERE organization_id = ?",
            )
            .bind(organization_id)
            .fetch_one(&self.pool)
            .await?,
            ..DashboardRollup::default()
        };
        rollup.by_status = self
            .count_certificates_by(organization_id, "status")
            .await?;
        rollup.by_key_algorithm = self
            .count_certificates_by(organization_id, "key_algorithm")
            .await?;
        rollup.by_issuing_ca = self
            .count_certificates_by(organization_id, "authority_id")
            .await?;
        rollup.by_enrollment_method = self
            .count_certificates_by(organization_id, "enrollment_method")
            .await?;
        let now = Utc::now();
        rollup.expiring_within_7_days = self.count_expiring_within(organization_id, now, 7).await?;
        rollup.expiring_within_30_days =
            self.count_expiring_within(organization_id, now, 30).await?;
        rollup.expiring_within_90_days =
            self.count_expiring_within(organization_id, now, 90).await?;
        Ok(rollup)
    }

    /// Group certificate counts by one of a fixed, non-caller-supplied set of
    /// columns. `column` is matched against a literal allowlist so the grouping
    /// expression is never assembled from caller input.
    async fn count_certificates_by(
        &self,
        organization_id: &str,
        column: &str,
    ) -> anyhow::Result<std::collections::BTreeMap<String, i64>> {
        let sql = match column {
            "status" => {
                "SELECT status AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY status"
            }
            "key_algorithm" => {
                "SELECT key_algorithm AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY key_algorithm"
            }
            "authority_id" => {
                "SELECT authority_id AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY authority_id"
            }
            "enrollment_method" => {
                "SELECT enrollment_method AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY enrollment_method"
            }
            _ => anyhow::bail!("unsupported dashboard grouping"),
        };
        let rows = sqlx::query(sql)
            .bind(organization_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<Option<String>, _>("bucket")
                        .unwrap_or_else(|| "unknown".to_string()),
                    row.get::<i64, _>("total"),
                )
            })
            .collect())
    }

    async fn count_expiring_within(
        &self,
        organization_id: &str,
        now: chrono::DateTime<Utc>,
        days: i64,
    ) -> anyhow::Result<i64> {
        let cutoff = (now + chrono::Duration::days(days)).to_rfc3339();
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?)",
        )
        .bind(organization_id)
        .bind(cutoff)
        .fetch_one(&self.pool)
        .await?)
    }
}
