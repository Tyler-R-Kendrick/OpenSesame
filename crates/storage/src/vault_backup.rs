//! Sealed attachment targets and the ADR 0039 backup target.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{AttachmentTarget, BackupTarget, Db, Row, Utc};

impl Db {
    /// Insert or update the encrypted-backup target for an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn upsert_backup_target(&self, target: &BackupTarget) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO backup_targets (organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, kind, provider_id, connection_id, config, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               integration_id = excluded.integration_id, \
               installation_id = excluded.installation_id, \
               owner = excluded.owner, \
               repo = excluded.repo, \
               branch = excluded.branch, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               kind = excluded.kind, \
               provider_id = excluded.provider_id, \
               connection_id = excluded.connection_id, \
               config = excluded.config, \
               last_error = NULL, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.integration_id)
        .bind(&target.installation_id)
        .bind(&target.owner)
        .bind(&target.repo)
        .bind(&target.branch)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(&target.kind)
        .bind(&target.provider_id)
        .bind(&target.connection_id)
        .bind(&target.config)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_backup_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<BackupTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, last_commit_sha, last_synced_at, last_error, kind, provider_id, connection_id, config \
             FROM backup_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| BackupTarget {
            organization_id: row.get("organization_id"),
            integration_id: row.get("integration_id"),
            installation_id: row.get("installation_id"),
            owner: row.get("owner"),
            repo: row.get("repo"),
            branch: row.get("branch"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_commit_sha: row.get("last_commit_sha"),
            last_synced_at: row.get("last_synced_at"),
            last_error: row.get("last_error"),
            kind: row.get("kind"),
            provider_id: row.get("provider_id"),
            connection_id: row.get("connection_id"),
            config: row.get("config"),
        }))
    }

    /// Record the outcome of a backup pass without touching the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the database update fails.
    pub async fn record_backup_outcome(
        &self,
        organization_id: &str,
        status: &str,
        last_commit_sha: Option<&str>,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE backup_targets SET status = ?, \
               last_commit_sha = COALESCE(?, last_commit_sha), \
               last_synced_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_synced_at END, \
               last_error = ?, updated_at = ? WHERE organization_id = ?",
        )
        .bind(status)
        .bind(last_commit_sha)
        .bind(last_commit_sha)
        .bind(Utc::now().to_rfc3339())
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert or update an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn upsert_attachment_target(&self, target: &AttachmentTarget) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO attachment_targets (organization_id, connection_id, provider_id, folder_path, enabled, status, updated_at_unix_ms, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               connection_id = excluded.connection_id, \
               provider_id = excluded.provider_id, \
               folder_path = excluded.folder_path, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               last_error = NULL, \
               updated_at_unix_ms = excluded.updated_at_unix_ms, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.connection_id)
        .bind(&target.provider_id)
        .bind(&target.folder_path)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(target.updated_at_unix_ms)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_attachment_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<AttachmentTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, connection_id, provider_id, folder_path, enabled, status, last_error, updated_at_unix_ms \
             FROM attachment_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AttachmentTarget {
            organization_id: row.get("organization_id"),
            connection_id: row.get("connection_id"),
            provider_id: row.get("provider_id"),
            folder_path: row.get("folder_path"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_error: row.get("last_error"),
            updated_at_unix_ms: row.get("updated_at_unix_ms"),
        }))
    }

    /// Record a replication failure without disturbing the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn record_attachment_target_error(
        &self,
        organization_id: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE attachment_targets SET status = ?, last_error = ?, updated_at = ? \
             WHERE organization_id = ?",
        )
        .bind(if last_error.is_some() { "error" } else { "ok" })
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_attachment_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM attachment_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_backup_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM backup_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
