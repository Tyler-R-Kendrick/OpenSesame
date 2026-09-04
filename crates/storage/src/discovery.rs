//! Certificate discovery jobs and the installations they find.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_discovery_installation, stored_discovery_job, validate_json_document, Db,
    StoredDiscoveryInstallation, StoredDiscoveryJob,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when the target documents are malformed or the insert
    /// fails.
    pub async fn insert_discovery_job(&self, job: &StoredDiscoveryJob) -> anyhow::Result<()> {
        validate_json_document(&job.targets_json, "discovery targets")?;
        validate_json_document(&job.ports_json, "discovery ports")?;
        self.ensure_organization_row(&job.organization_id, &job.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO discovery_jobs (id, organization_id, name, description, targets_json, ports_json, auto_scan, scan_interval_days, gateway_ref, allow_internal, last_scan_at, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&job.id)
        .bind(&job.organization_id)
        .bind(&job.name)
        .bind(&job.description)
        .bind(&job.targets_json)
        .bind(&job.ports_json)
        .bind(i64::from(job.auto_scan))
        .bind(job.scan_interval_days)
        .bind(&job.gateway_ref)
        .bind(i64::from(job.allow_internal))
        .bind(&job.last_scan_at)
        .bind(&job.status)
        .bind(job.version)
        .bind(&job.created_at)
        .bind(&job.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_discovery_job(
        &self,
        organization_id: &str,
        job_id: &str,
    ) -> anyhow::Result<Option<StoredDiscoveryJob>> {
        let row = sqlx::query("SELECT * FROM discovery_jobs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(job_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_discovery_job))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_discovery_jobs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredDiscoveryJob>> {
        let rows =
            sqlx::query("SELECT * FROM discovery_jobs WHERE organization_id = ? ORDER BY name, id")
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.iter().map(stored_discovery_job).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_discovery_job(&self, job: &StoredDiscoveryJob) -> anyhow::Result<bool> {
        validate_json_document(&job.targets_json, "discovery targets")?;
        validate_json_document(&job.ports_json, "discovery ports")?;
        let result = sqlx::query(
            "UPDATE discovery_jobs SET name = ?, description = ?, targets_json = ?, ports_json = ?, auto_scan = ?, scan_interval_days = ?, gateway_ref = ?, allow_internal = ?, last_scan_at = ?, status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&job.name)
        .bind(&job.description)
        .bind(&job.targets_json)
        .bind(&job.ports_json)
        .bind(i64::from(job.auto_scan))
        .bind(job.scan_interval_days)
        .bind(&job.gateway_ref)
        .bind(i64::from(job.allow_internal))
        .bind(&job.last_scan_at)
        .bind(&job.status)
        .bind(now_rfc3339())
        .bind(&job.organization_id)
        .bind(&job.id)
        .bind(job.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_discovery_job(
        &self,
        organization_id: &str,
        job_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM discovery_jobs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Insert or refresh one observed TLS installation.
    ///
    /// # Errors
    ///
    /// Returns an error when the change log is malformed or the upsert fails.
    pub async fn record_installation(
        &self,
        installation: &StoredDiscoveryInstallation,
    ) -> anyhow::Result<()> {
        validate_json_document(&installation.change_log_json, "discovery change log")?;
        sqlx::query(
            "INSERT INTO discovery_installations (id, organization_id, job_id, host, port, fingerprint_sha256, cn, issuer, not_after, first_seen_at, last_seen_at, change_log_json, matched_certificate_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, job_id, host, port) DO UPDATE SET \
               fingerprint_sha256 = excluded.fingerprint_sha256, cn = excluded.cn, issuer = excluded.issuer, \
               not_after = excluded.not_after, last_seen_at = excluded.last_seen_at, \
               change_log_json = excluded.change_log_json, matched_certificate_id = excluded.matched_certificate_id, \
               version = discovery_installations.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&installation.id)
        .bind(&installation.organization_id)
        .bind(&installation.job_id)
        .bind(&installation.host)
        .bind(installation.port)
        .bind(&installation.fingerprint_sha256)
        .bind(&installation.cn)
        .bind(&installation.issuer)
        .bind(&installation.not_after)
        .bind(&installation.first_seen_at)
        .bind(&installation.last_seen_at)
        .bind(&installation.change_log_json)
        .bind(&installation.matched_certificate_id)
        .bind(installation.version)
        .bind(&installation.created_at)
        .bind(&installation.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_installations(
        &self,
        organization_id: &str,
        job_id: Option<&str>,
    ) -> anyhow::Result<Vec<StoredDiscoveryInstallation>> {
        let rows = match job_id {
            Some(job_id) => {
                sqlx::query(
                    "SELECT * FROM discovery_installations WHERE organization_id = ? AND job_id = ? ORDER BY host, port",
                )
                .bind(organization_id)
                .bind(job_id)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT * FROM discovery_installations WHERE organization_id = ? ORDER BY host, port",
                )
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.iter().map(stored_discovery_installation).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn match_installation_by_fingerprint(
        &self,
        organization_id: &str,
        fingerprint_sha256: &str,
    ) -> anyhow::Result<Vec<StoredDiscoveryInstallation>> {
        let rows = sqlx::query(
            "SELECT * FROM discovery_installations WHERE organization_id = ? AND fingerprint_sha256 = ? ORDER BY host, port",
        )
        .bind(organization_id)
        .bind(fingerprint_sha256)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_discovery_installation).collect())
    }

    // —— approvals ——————————————————————————————————————————————————
}
