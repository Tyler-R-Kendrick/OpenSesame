//! Signing access records and the append-only signing event log.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_signing_access_record, stored_signing_event, validate_json_document,
    Context, Db, StoredSigningAccessRecord, StoredSigningEvent,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when `scope_json` is malformed or the insert fails.
    pub async fn insert_signing_access_record(
        &self,
        record: &StoredSigningAccessRecord,
    ) -> anyhow::Result<()> {
        validate_json_document(&record.scope_json, "signing access scope")?;
        sqlx::query(
            "INSERT INTO signing_access_records (id, organization_id, signer_id, approval_request_id, status, signatures_allowed, signatures_used, window_expires_at, scope_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.id)
        .bind(&record.organization_id)
        .bind(&record.signer_id)
        .bind(&record.approval_request_id)
        .bind(&record.status)
        .bind(record.signatures_allowed)
        .bind(record.signatures_used)
        .bind(&record.window_expires_at)
        .bind(&record.scope_json)
        .bind(record.version)
        .bind(&record.created_at)
        .bind(&record.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_signing_access_record(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<Option<StoredSigningAccessRecord>> {
        let row = sqlx::query(
            "SELECT * FROM signing_access_records WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(record_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_signing_access_record))
    }

    /// Consume one signature against an access record.
    ///
    /// The increment is a single conditional statement, so racing signers
    /// cannot together exceed the cap.
    ///
    /// # Errors
    ///
    /// Returns an error when the record is absent, inactive, past its window,
    /// or already at its signature cap.
    pub async fn increment_signature_count(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<u32> {
        let now = now_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE signing_access_records SET signatures_used = signatures_used + 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = 'active' \
               AND (signatures_allowed IS NULL OR signatures_used < signatures_allowed) \
               AND (window_expires_at IS NULL OR julianday(window_expires_at) > julianday(?))",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(record_id)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("signing access record is exhausted, expired, or inactive");
        }
        let used = sqlx::query_scalar::<_, i64>(
            "SELECT signatures_used FROM signing_access_records WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(record_id)
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        u32::try_from(used).context("signature count exceeds the supported range")
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn revoke_access_record(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE signing_access_records SET status = 'revoked', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status <> 'revoked'",
        )
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(record_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Append one entry to the code-signing activity ledger. Callers redact
    /// credential arguments from `command` before writing.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn append_signing_event(&self, event: &StoredSigningEvent) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO signing_events (id, organization_id, signer_id, access_record_id, outcome, command, application_name, application_sha256, hostname, os_username, ip, data_hash, occurred_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&event.id)
        .bind(&event.organization_id)
        .bind(&event.signer_id)
        .bind(&event.access_record_id)
        .bind(&event.outcome)
        .bind(&event.command)
        .bind(&event.application_name)
        .bind(&event.application_sha256)
        .bind(&event.hostname)
        .bind(&event.os_username)
        .bind(&event.ip)
        .bind(&event.data_hash)
        .bind(&event.occurred_at)
        .bind(event.version)
        .bind(&event.created_at)
        .bind(&event.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signing_events(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSigningEvent>> {
        let rows = sqlx::query(
            "SELECT * FROM signing_events WHERE organization_id = ? AND signer_id = ? ORDER BY occurred_at, id",
        )
        .bind(organization_id)
        .bind(signer_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signing_event).collect())
    }

    /// Access records that are still usable for a signer right now.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_active_records(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSigningAccessRecord>> {
        let rows = sqlx::query(
            "SELECT * FROM signing_access_records \
             WHERE organization_id = ? AND signer_id = ? AND status = 'active' \
               AND (window_expires_at IS NULL OR julianday(window_expires_at) > julianday(?)) \
             ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(now_rfc3339())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signing_access_record).collect())
    }
}
