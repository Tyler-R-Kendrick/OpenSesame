//! Certificate expiry alerts, their deliveries, and sync runs.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_alert_delivery, stored_cert_alert, stored_cert_sync, stored_sync_run,
    validate_json_document, Db, StoredAlertDelivery, StoredCertAlert, StoredCertSync,
    StoredSyncRun,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when `channels_json` is malformed or the insert fails.
    pub async fn insert_cert_alert(&self, alert: &StoredCertAlert) -> anyhow::Result<()> {
        validate_json_document(&alert.channels_json, "alert channels")?;
        sqlx::query(
            "INSERT INTO cert_alerts (id, organization_id, application_id, type, before_window_seconds, daily_reminder, channels_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&alert.id)
        .bind(&alert.organization_id)
        .bind(&alert.application_id)
        .bind(&alert.alert_type)
        .bind(alert.before_window_seconds)
        .bind(i64::from(alert.daily_reminder))
        .bind(&alert.channels_json)
        .bind(alert.version)
        .bind(&alert.created_at)
        .bind(&alert.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_cert_alert(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<Option<StoredCertAlert>> {
        let row = sqlx::query("SELECT * FROM cert_alerts WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(alert_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_cert_alert))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_cert_alerts(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredCertAlert>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_alerts WHERE organization_id = ? AND application_id = ? ORDER BY type, id",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_alert).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_cert_alert(&self, alert: &StoredCertAlert) -> anyhow::Result<bool> {
        validate_json_document(&alert.channels_json, "alert channels")?;
        let result = sqlx::query(
            "UPDATE cert_alerts SET type = ?, before_window_seconds = ?, daily_reminder = ?, channels_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&alert.alert_type)
        .bind(alert.before_window_seconds)
        .bind(i64::from(alert.daily_reminder))
        .bind(&alert.channels_json)
        .bind(now_rfc3339())
        .bind(&alert.organization_id)
        .bind(&alert.id)
        .bind(alert.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_cert_alert(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM cert_alerts WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(alert_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn record_alert_delivery(
        &self,
        delivery: &StoredAlertDelivery,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO alert_deliveries (id, organization_id, alert_id, channel, outcome, attempts, last_attempt_at, payload_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&delivery.id)
        .bind(&delivery.organization_id)
        .bind(&delivery.alert_id)
        .bind(&delivery.channel)
        .bind(&delivery.outcome)
        .bind(delivery.attempts)
        .bind(&delivery.last_attempt_at)
        .bind(&delivery.payload_digest)
        .bind(delivery.version)
        .bind(&delivery.created_at)
        .bind(&delivery.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_alert_deliveries(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<Vec<StoredAlertDelivery>> {
        let rows = sqlx::query(
            "SELECT * FROM alert_deliveries WHERE organization_id = ? AND alert_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(alert_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_alert_delivery).collect())
    }

    // —— certificate syncs ————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `options_json` is malformed or the insert fails.
    pub async fn insert_cert_sync(&self, sync: &StoredCertSync) -> anyhow::Result<()> {
        validate_json_document(&sync.options_json, "certificate sync options")?;
        sqlx::query(
            "INSERT INTO cert_syncs (id, organization_id, certificate_id, destination_kind, connection_id, name_schema, remove_on_expiry, include_root, options_json, enabled, last_run_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&sync.id)
        .bind(&sync.organization_id)
        .bind(&sync.certificate_id)
        .bind(&sync.destination_kind)
        .bind(&sync.connection_id)
        .bind(&sync.name_schema)
        .bind(i64::from(sync.remove_on_expiry))
        .bind(i64::from(sync.include_root))
        .bind(&sync.options_json)
        .bind(i64::from(sync.enabled))
        .bind(&sync.last_run_at)
        .bind(sync.version)
        .bind(&sync.created_at)
        .bind(&sync.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_cert_sync(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<Option<StoredCertSync>> {
        let row = sqlx::query("SELECT * FROM cert_syncs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(sync_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_cert_sync))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_cert_syncs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertSync>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_syncs WHERE organization_id = ? ORDER BY certificate_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_sync).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_cert_sync(&self, sync: &StoredCertSync) -> anyhow::Result<bool> {
        validate_json_document(&sync.options_json, "certificate sync options")?;
        let result = sqlx::query(
            "UPDATE cert_syncs SET destination_kind = ?, connection_id = ?, name_schema = ?, remove_on_expiry = ?, include_root = ?, options_json = ?, enabled = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&sync.destination_kind)
        .bind(&sync.connection_id)
        .bind(&sync.name_schema)
        .bind(i64::from(sync.remove_on_expiry))
        .bind(i64::from(sync.include_root))
        .bind(&sync.options_json)
        .bind(i64::from(sync.enabled))
        .bind(now_rfc3339())
        .bind(&sync.organization_id)
        .bind(&sync.id)
        .bind(sync.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_cert_sync(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM cert_syncs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(sync_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Append a sync run and stamp the parent sync in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the sync is absent from the organization or the
    /// transaction fails.
    pub async fn record_sync_run(&self, run: &StoredSyncRun) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO sync_runs (id, organization_id, sync_id, outcome, detail, ran_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&run.id)
        .bind(&run.organization_id)
        .bind(&run.sync_id)
        .bind(&run.outcome)
        .bind(&run.detail)
        .bind(&run.ran_at)
        .bind(run.version)
        .bind(&run.created_at)
        .bind(&run.updated_at)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE cert_syncs SET last_run_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(&run.ran_at)
        .bind(now_rfc3339())
        .bind(&run.organization_id)
        .bind(&run.sync_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("sync run target is not in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_sync_runs(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<Vec<StoredSyncRun>> {
        let rows = sqlx::query(
            "SELECT * FROM sync_runs WHERE organization_id = ? AND sync_id = ? ORDER BY ran_at, id",
        )
        .bind(organization_id)
        .bind(sync_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_sync_run).collect())
    }

    // —— HSM connectors ————————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_active_syncs_for_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Vec<StoredCertSync>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_syncs WHERE organization_id = ? AND certificate_id = ? AND enabled = 1 ORDER BY destination_kind, id",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_sync).collect())
    }
}
