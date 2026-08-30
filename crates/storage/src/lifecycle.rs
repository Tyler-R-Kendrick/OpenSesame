//! Persistence for expiry lifecycle hooks (ADR 0073).
//!
//! Three concerns, deliberately kept apart:
//!
//! - [`StoredLifecycleHook`] — who subscribes and where it is delivered. The
//!   Standard Webhooks signing secret lives in a sealed column group and never
//!   renders through `Debug`.
//! - [`StoredLifecycleWatermark`] — how far up each ladder a subject has been
//!   reported, so a rung fires exactly once.
//! - [`StoredLifecycleDelivery`] — the outbound ledger, with the ADR 0039 saga
//!   shape (claim under lease, backoff, dead-letter) but its own table, so hook
//!   fan-out never provokes the backup actor.

use anyhow::Context;
use chrono::{DateTime, Utc};
use sqlx::{sqlite::SqliteRow, Row};

// `optional_sealed_material!` is a textually scoped `macro_rules!` macro from
// the crate root; it is in scope here without a `use` because this module is
// declared after its definition.
use crate::{
    sealed_parts, validate_json_document, validate_optional_sealed_material, Db,
    SealedCertificateMaterial,
};

/// Seal scope for a hook's Standard Webhooks signing secret. Distinct from
/// every Certificate Manager scope, so a hook secret cannot be opened as a
/// signing key even if rows were moved between tables.
pub const LIFECYCLE_HOOK_SECRET_SCOPE: &str = "lifecycle_hook_secret";

/// Deliveries handed out in one claim.
pub const DELIVERY_BATCH_LIMIT: usize = 32;

/// A registered lifecycle subscription. The sealed signing secret never
/// renders through `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredLifecycleHook {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    /// Frozen lifecycle event types, or the `lifecycle.*` wildcard.
    pub event_types: Vec<String>,
    /// `webhook` or `internal`.
    pub delivery: String,
    pub endpoint_url: Option<String>,
    pub responder: Option<String>,
    /// `None` means every subject kind.
    pub subject_kinds: Option<Vec<String>>,
    pub enabled: bool,
    pub sealed_secret: Option<SealedCertificateMaterial>,
    pub last_delivered_at: Option<String>,
    pub last_error: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredLifecycleHook {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredLifecycleHook")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("name", &self.name)
            .field("event_types", &self.event_types)
            .field("delivery", &self.delivery)
            .field("endpoint_url", &self.endpoint_url)
            .field("responder", &self.responder)
            .field("subject_kinds", &self.subject_kinds)
            .field("enabled", &self.enabled)
            .field("sealed_secret", &"[REDACTED]")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// One track's high-water mark for one subject.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredLifecycleWatermark {
    pub organization_id: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub track: String,
    pub stage: String,
    pub threshold_seconds: i64,
    pub expires_at: String,
}

/// One queued or settled outbound delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredLifecycleDelivery {
    pub id: String,
    pub organization_id: String,
    pub hook_id: String,
    pub event_type: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub payload_json: String,
    pub state: String,
    pub attempts: i64,
    pub available_at: Option<String>,
    pub last_error: Option<String>,
    pub delivered_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn hook_from_row(row: &SqliteRow) -> anyhow::Result<StoredLifecycleHook> {
    let event_types_json: String = row.get("event_types_json");
    let subject_kinds_json: Option<String> = row.get("subject_kinds_json");
    Ok(StoredLifecycleHook {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        event_types: serde_json::from_str(&event_types_json)
            .context("lifecycle hook event_types_json is not a JSON array of strings")?,
        delivery: row.get("delivery"),
        endpoint_url: row.get("endpoint_url"),
        responder: row.get("responder"),
        subject_kinds: subject_kinds_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .context("lifecycle hook subject_kinds_json is not a JSON array of strings")?,
        enabled: row.get::<i64, _>("enabled") != 0,
        sealed_secret: optional_sealed_material!(row, "sealed_secret"),
        last_delivered_at: row.get("last_delivered_at"),
        last_error: row.get("last_error"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn watermark_from_row(row: &SqliteRow) -> StoredLifecycleWatermark {
    StoredLifecycleWatermark {
        organization_id: row.get("organization_id"),
        subject_kind: row.get("subject_kind"),
        subject_id: row.get("subject_id"),
        track: row.get("track"),
        stage: row.get("stage"),
        threshold_seconds: row.get("threshold_seconds"),
        expires_at: row.get("expires_at"),
    }
}

fn delivery_from_row(row: &SqliteRow) -> StoredLifecycleDelivery {
    StoredLifecycleDelivery {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        hook_id: row.get("hook_id"),
        event_type: row.get("event_type"),
        subject_kind: row.get("subject_kind"),
        subject_id: row.get("subject_id"),
        payload_json: row.get("payload_json"),
        state: row.get("state"),
        attempts: row.get("attempts"),
        available_at: row.get("available_at"),
        last_error: row.get("last_error"),
        delivered_at: row.get("delivered_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

impl Db {
    // —— hooks ————————————————————————————————————————————————————

    /// Create or replace a subscription. `version` advances on every write so
    /// a concurrent editor's read is detectably stale.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed group is malformed, the JSON columns
    /// are not arrays, or the row violates a schema `CHECK`.
    pub async fn upsert_lifecycle_hook(&self, hook: &StoredLifecycleHook) -> anyhow::Result<()> {
        validate_optional_sealed_material(hook.sealed_secret.as_ref())?;
        let event_types_json = serde_json::to_string(&hook.event_types)
            .context("encode lifecycle hook event types")?;
        validate_json_document(&event_types_json, "lifecycle hook event types")?;
        let subject_kinds_json = hook
            .subject_kinds
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .context("encode lifecycle hook subject kinds")?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(hook.sealed_secret.as_ref());
        sqlx::query(
            "INSERT INTO lifecycle_hooks (id, organization_id, name, event_types_json, delivery, endpoint_url, responder, subject_kinds_json, enabled, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, last_delivered_at, last_error, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, event_types_json = excluded.event_types_json, \
               delivery = excluded.delivery, endpoint_url = excluded.endpoint_url, responder = excluded.responder, \
               subject_kinds_json = excluded.subject_kinds_json, enabled = excluded.enabled, \
               sealed_secret_key_id = excluded.sealed_secret_key_id, sealed_secret_ciphertext = excluded.sealed_secret_ciphertext, \
               sealed_secret_nonce = excluded.sealed_secret_nonce, sealed_secret_aad_digest = excluded.sealed_secret_aad_digest, \
               version = lifecycle_hooks.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&hook.id)
        .bind(&hook.organization_id)
        .bind(&hook.name)
        .bind(&event_types_json)
        .bind(&hook.delivery)
        .bind(&hook.endpoint_url)
        .bind(&hook.responder)
        .bind(&subject_kinds_json)
        .bind(i64::from(hook.enabled))
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&hook.last_delivered_at)
        .bind(&hook.last_error)
        .bind(hook.version.max(1))
        .bind(&hook.created_at)
        .bind(&hook.updated_at)
        .execute(&self.pool)
        .await
        .context("upsert lifecycle hook")?;
        Ok(())
    }

    /// Every subscription for an organization, newest name order.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row cannot be decoded.
    pub async fn list_lifecycle_hooks(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredLifecycleHook>> {
        let rows = sqlx::query(
            "SELECT * FROM lifecycle_hooks WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await
        .context("list lifecycle hooks")?;
        rows.iter().map(hook_from_row).collect()
    }

    /// One subscription by id, scoped to its organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row cannot be decoded.
    pub async fn get_lifecycle_hook(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<StoredLifecycleHook>> {
        let row = sqlx::query("SELECT * FROM lifecycle_hooks WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("get lifecycle hook")?;
        row.as_ref().map(hook_from_row).transpose()
    }

    /// Remove a subscription and, by cascade, its queued deliveries.
    ///
    /// # Errors
    ///
    /// Returns an error when the delete fails.
    pub async fn delete_lifecycle_hook(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM lifecycle_hooks WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("delete lifecycle hook")?;
        Ok(result.rows_affected() > 0)
    }

    /// Record the outcome of a delivery attempt on the hook itself, so an
    /// operator sees a failing endpoint without joining the ledger.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn record_lifecycle_hook_attempt(
        &self,
        organization_id: &str,
        id: &str,
        at: DateTime<Utc>,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE lifecycle_hooks SET last_delivered_at = ?, last_error = ?, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(if error.is_none() {
            Some(at.to_rfc3339())
        } else {
            None
        })
        .bind(error)
        .bind(at.to_rfc3339())
        .bind(organization_id)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("record lifecycle hook attempt")?;
        Ok(())
    }

    // —— watermarks ————————————————————————————————————————————————

    /// Both tracks' watermarks for one subject.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_lifecycle_watermarks(
        &self,
        organization_id: &str,
        subject_kind: &str,
        subject_id: &str,
    ) -> anyhow::Result<Vec<StoredLifecycleWatermark>> {
        let rows = sqlx::query(
            "SELECT * FROM lifecycle_watermarks \
             WHERE organization_id = ? AND subject_kind = ? AND subject_id = ?",
        )
        .bind(organization_id)
        .bind(subject_kind)
        .bind(subject_id)
        .fetch_all(&self.pool)
        .await
        .context("get lifecycle watermarks")?;
        Ok(rows.iter().map(watermark_from_row).collect())
    }

    /// Every watermark for an organization, for a bulk scanner pass.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_lifecycle_watermarks(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredLifecycleWatermark>> {
        let rows = sqlx::query(
            "SELECT * FROM lifecycle_watermarks WHERE organization_id = ? \
             ORDER BY subject_kind, subject_id, track",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await
        .context("list lifecycle watermarks")?;
        Ok(rows.iter().map(watermark_from_row).collect())
    }

    /// Advance one track's watermark. Idempotent by primary key.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails or violates the track/stage
    /// `CHECK` that keeps the two ladders disjoint.
    pub async fn record_lifecycle_watermark(
        &self,
        mark: &StoredLifecycleWatermark,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let now = now.to_rfc3339();
        sqlx::query(
            "INSERT INTO lifecycle_watermarks (organization_id, subject_kind, subject_id, track, stage, threshold_seconds, expires_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, subject_kind, subject_id, track) DO UPDATE SET \
               stage = excluded.stage, threshold_seconds = excluded.threshold_seconds, \
               expires_at = excluded.expires_at, updated_at = excluded.updated_at",
        )
        .bind(&mark.organization_id)
        .bind(&mark.subject_kind)
        .bind(&mark.subject_id)
        .bind(&mark.track)
        .bind(&mark.stage)
        .bind(mark.threshold_seconds)
        .bind(&mark.expires_at)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .context("record lifecycle watermark")?;
        Ok(())
    }

    /// Forget a subject's watermarks — used when the subject itself is gone,
    /// so a recycled id cannot inherit a stale ladder position.
    ///
    /// # Errors
    ///
    /// Returns an error when the delete fails.
    pub async fn clear_lifecycle_watermarks(
        &self,
        organization_id: &str,
        subject_kind: &str,
        subject_id: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "DELETE FROM lifecycle_watermarks \
             WHERE organization_id = ? AND subject_kind = ? AND subject_id = ?",
        )
        .bind(organization_id)
        .bind(subject_kind)
        .bind(subject_id)
        .execute(&self.pool)
        .await
        .context("clear lifecycle watermarks")?;
        Ok(())
    }

    // —— delivery ledger ——————————————————————————————————————————

    /// Queue one delivery.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails or the payload is not JSON.
    pub async fn enqueue_lifecycle_delivery(
        &self,
        delivery: &StoredLifecycleDelivery,
    ) -> anyhow::Result<()> {
        validate_json_document(&delivery.payload_json, "lifecycle delivery payload")?;
        sqlx::query(
            "INSERT INTO lifecycle_deliveries (id, organization_id, hook_id, event_type, subject_kind, subject_id, payload_json, state, attempts, available_at, last_error, delivered_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&delivery.id)
        .bind(&delivery.organization_id)
        .bind(&delivery.hook_id)
        .bind(&delivery.event_type)
        .bind(&delivery.subject_kind)
        .bind(&delivery.subject_id)
        .bind(&delivery.payload_json)
        .bind(&delivery.state)
        .bind(delivery.attempts)
        .bind(&delivery.available_at)
        .bind(&delivery.last_error)
        .bind(&delivery.delivered_at)
        .bind(&delivery.created_at)
        .bind(&delivery.updated_at)
        .execute(&self.pool)
        .await
        .context("enqueue lifecycle delivery")?;
        Ok(())
    }

    /// Claim up to `limit` pending deliveries whose backoff has elapsed,
    /// parking each under a lease so a second worker cannot take it.
    ///
    /// Mirrors [`Db::claim_outbox_batch`]: the claim advances `available_at`
    /// so a crashed worker's rows become claimable again instead of wedging
    /// the queue.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn claim_lifecycle_deliveries(
        &self,
        limit: usize,
        lease_seconds: i64,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<StoredLifecycleDelivery>> {
        let mut transaction = self.pool.begin().await.context("begin delivery claim")?;
        let rows = sqlx::query(
            "SELECT * FROM lifecycle_deliveries \
             WHERE state = 'pending' AND (available_at IS NULL OR available_at <= ?) \
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(i64::try_from(limit.min(DELIVERY_BATCH_LIMIT)).unwrap_or(1))
        .fetch_all(&mut *transaction)
        .await
        .context("claim lifecycle deliveries")?;

        let lease_until = (now + chrono::Duration::seconds(lease_seconds.max(1))).to_rfc3339();
        let claimed: Vec<StoredLifecycleDelivery> =
            rows.iter().map(delivery_from_row).collect();
        for delivery in &claimed {
            sqlx::query("UPDATE lifecycle_deliveries SET available_at = ? WHERE id = ?")
                .bind(&lease_until)
                .bind(&delivery.id)
                .execute(&mut *transaction)
                .await
                .context("lease lifecycle delivery")?;
        }
        transaction.commit().await.context("commit delivery claim")?;
        Ok(claimed)
    }

    /// Mark a delivery delivered.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn mark_lifecycle_delivered(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let now = now.to_rfc3339();
        sqlx::query(
            "UPDATE lifecycle_deliveries SET state = 'delivered', delivered_at = ?, \
             last_error = NULL, available_at = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("mark lifecycle delivery delivered")?;
        Ok(())
    }

    /// Record a failed attempt and schedule the retry.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn park_lifecycle_delivery(
        &self,
        id: &str,
        retry_at: DateTime<Utc>,
        error: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE lifecycle_deliveries SET attempts = attempts + 1, available_at = ?, \
             last_error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(retry_at.to_rfc3339())
        .bind(error)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .context("park lifecycle delivery")?;
        Ok(())
    }

    /// Give up on a delivery. The row is kept: a dead letter an operator can
    /// see is the point, and silently dropping one would hide a broken hook.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn dead_letter_lifecycle_delivery(
        &self,
        id: &str,
        error: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE lifecycle_deliveries SET state = 'dead_lettered', attempts = attempts + 1, \
             available_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(error)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .context("dead-letter lifecycle delivery")?;
        Ok(())
    }

    /// Recent deliveries for an organization, newest first.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_lifecycle_deliveries(
        &self,
        organization_id: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredLifecycleDelivery>> {
        let rows = sqlx::query(
            "SELECT * FROM lifecycle_deliveries WHERE organization_id = ? \
             ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(organization_id)
        .bind(i64::try_from(limit.clamp(1, 500)).unwrap_or(50))
        .fetch_all(&self.pool)
        .await
        .context("list lifecycle deliveries")?;
        Ok(rows.iter().map(delivery_from_row).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "org:lifecycle";
    const NOW: &str = "2026-08-30T00:00:00+00:00";

    fn now() -> DateTime<Utc> {
        NOW.parse().unwrap()
    }

    /// A migrated database with `ORG` present. Every lifecycle table carries a
    /// real `organizations` foreign key, and foreign keys are enforced on this
    /// pool, so the tenant row has to exist first.
    async fn seeded_db() -> Db {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(ORG)
            .bind("Lifecycle")
            .bind(NOW)
            .execute(db.pool())
            .await
            .unwrap();
        db
    }

    fn webhook_hook(id: &str, name: &str) -> StoredLifecycleHook {
        StoredLifecycleHook {
            id: id.into(),
            organization_id: ORG.into(),
            name: name.into(),
            event_types: vec!["lifecycle.renewal.due".into()],
            delivery: "webhook".into(),
            endpoint_url: Some("https://hooks.example/expiry".into()),
            responder: None,
            subject_kinds: Some(vec!["certificate".into()]),
            enabled: true,
            sealed_secret: Some(SealedCertificateMaterial {
                key_id: "seal:hook".into(),
                ciphertext: vec![1, 2, 3],
                nonce: vec![4, 5, 6],
                aad_digest: "sha256:hook".into(),
            }),
            last_delivered_at: None,
            last_error: None,
            version: 1,
            created_at: NOW.into(),
            updated_at: NOW.into(),
        }
    }

    fn internal_hook(id: &str, name: &str) -> StoredLifecycleHook {
        StoredLifecycleHook {
            delivery: "internal".into(),
            endpoint_url: None,
            responder: Some("rotation".into()),
            sealed_secret: None,
            subject_kinds: None,
            event_types: vec!["lifecycle.*".into()],
            ..webhook_hook(id, name)
        }
    }

    fn watermark(track: &str, stage: &str, threshold: i64) -> StoredLifecycleWatermark {
        StoredLifecycleWatermark {
            organization_id: ORG.into(),
            subject_kind: "certificate".into(),
            subject_id: "cert:1".into(),
            track: track.into(),
            stage: stage.into(),
            threshold_seconds: threshold,
            expires_at: "2026-09-30T00:00:00+00:00".into(),
        }
    }

    fn delivery(id: &str, hook_id: &str) -> StoredLifecycleDelivery {
        StoredLifecycleDelivery {
            id: id.into(),
            organization_id: ORG.into(),
            hook_id: hook_id.into(),
            event_type: "lifecycle.renewal.due".into(),
            subject_kind: "certificate".into(),
            subject_id: "cert:1".into(),
            payload_json: r#"{"event_type":"lifecycle.renewal.due"}"#.into(),
            state: "pending".into(),
            attempts: 0,
            available_at: None,
            last_error: None,
            delivered_at: None,
            created_at: NOW.into(),
            updated_at: NOW.into(),
        }
    }

    #[tokio::test]
    async fn migration_creates_every_lifecycle_table() {
        let db = Db::connect_memory().await.unwrap();
        assert!(db
            .applied_migrations()
            .await
            .unwrap()
            .contains(&"0017_lifecycle_hooks".to_string()));
        for table in [
            "lifecycle_hooks",
            "lifecycle_watermarks",
            "lifecycle_deliveries",
        ] {
            sqlx::query(&format!("SELECT 1 FROM {table} LIMIT 0"))
                .execute(db.pool())
                .await
                .unwrap_or_else(|error| panic!("{table} is missing: {error}"));
        }
    }

    #[tokio::test]
    async fn hooks_round_trip_and_upsert_advances_the_version() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        let stored = db
            .get_lifecycle_hook(ORG, "hook:1")
            .await
            .unwrap()
            .expect("hook is stored");
        assert_eq!(stored.event_types, vec!["lifecycle.renewal.due"]);
        assert_eq!(stored.subject_kinds, Some(vec!["certificate".into()]));
        assert_eq!(stored.version, 1);
        assert!(stored.sealed_secret.is_some());

        let mut edited = webhook_hook("hook:1", "expiry");
        edited.enabled = false;
        db.upsert_lifecycle_hook(&edited).await.unwrap();
        let stored = db.get_lifecycle_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert!(!stored.enabled);
        assert_eq!(stored.version, 2, "an edit must advance the version");
    }

    #[tokio::test]
    async fn a_hook_is_scoped_to_its_organization() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        assert!(db
            .get_lifecycle_hook("org:other", "hook:1")
            .await
            .unwrap()
            .is_none());
        assert!(db.list_lifecycle_hooks("org:other").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_webhook_hook_without_an_endpoint_is_refused() {
        let db = seeded_db().await;
        let mut broken = webhook_hook("hook:1", "expiry");
        broken.endpoint_url = None;
        assert!(
            db.upsert_lifecycle_hook(&broken).await.is_err(),
            "the schema CHECK must refuse a webhook hook with nowhere to deliver",
        );
    }

    #[tokio::test]
    async fn an_internal_hook_may_not_carry_a_signing_secret() {
        let db = seeded_db().await;
        let mut broken = internal_hook("hook:1", "rotation");
        broken.sealed_secret = Some(SealedCertificateMaterial {
            key_id: "seal:hook".into(),
            ciphertext: vec![1],
            nonce: vec![2],
            aad_digest: "sha256:x".into(),
        });
        assert!(
            db.upsert_lifecycle_hook(&broken).await.is_err(),
            "an in-process responder signs nothing and must store nothing",
        );
    }

    #[tokio::test]
    async fn an_internal_hook_round_trips() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&internal_hook("hook:rot", "rotation"))
            .await
            .unwrap();
        let stored = db.get_lifecycle_hook(ORG, "hook:rot").await.unwrap().unwrap();
        assert_eq!(stored.responder.as_deref(), Some("rotation"));
        assert_eq!(stored.endpoint_url, None);
        assert_eq!(stored.subject_kinds, None, "None means every subject kind");
    }

    #[tokio::test]
    async fn a_hook_debug_redacts_its_signing_secret() {
        let rendered = format!("{:?}", webhook_hook("hook:1", "expiry"));
        assert!(rendered.contains("[REDACTED]"), "{rendered}");
        assert!(!rendered.contains("seal:hook"), "{rendered}");
    }

    #[tokio::test]
    async fn deleting_a_hook_cascades_to_its_queued_deliveries() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_lifecycle_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        assert!(db.delete_lifecycle_hook(ORG, "hook:1").await.unwrap());
        assert!(db.list_lifecycle_deliveries(ORG, 10).await.unwrap().is_empty());
        assert!(!db.delete_lifecycle_hook(ORG, "hook:1").await.unwrap());
    }

    #[tokio::test]
    async fn watermarks_are_keyed_per_track_and_upsert_in_place() {
        let db = seeded_db().await;
        db.record_lifecycle_watermark(&watermark("alert", "notice", 2_592_000), now())
            .await
            .unwrap();
        db.record_lifecycle_watermark(&watermark("renewal", "renewal", 604_800), now())
            .await
            .unwrap();
        let marks = db
            .get_lifecycle_watermarks(ORG, "certificate", "cert:1")
            .await
            .unwrap();
        assert_eq!(marks.len(), 2, "one row per track: {marks:?}");

        // Advancing the alert track must not disturb the renewal track.
        db.record_lifecycle_watermark(&watermark("alert", "urgent", 86_400), now())
            .await
            .unwrap();
        let marks = db
            .get_lifecycle_watermarks(ORG, "certificate", "cert:1")
            .await
            .unwrap();
        assert_eq!(marks.len(), 2);
        let alert = marks.iter().find(|m| m.track == "alert").unwrap();
        assert_eq!(alert.stage, "urgent");
        assert_eq!(alert.threshold_seconds, 86_400);
        let renewal = marks.iter().find(|m| m.track == "renewal").unwrap();
        assert_eq!(renewal.stage, "renewal");
    }

    #[tokio::test]
    async fn the_schema_keeps_the_two_tracks_disjoint() {
        let db = seeded_db().await;
        // The renewal rung on the alert track would let a per-subject renewal
        // lead alias a fixed alert rung and suppress it.
        assert!(db
            .record_lifecycle_watermark(&watermark("alert", "renewal", 604_800), now())
            .await
            .is_err());
        assert!(db
            .record_lifecycle_watermark(&watermark("renewal", "urgent", 86_400), now())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn clearing_watermarks_forgets_a_subject_entirely() {
        let db = seeded_db().await;
        db.record_lifecycle_watermark(&watermark("alert", "notice", 2_592_000), now())
            .await
            .unwrap();
        db.record_lifecycle_watermark(&watermark("renewal", "renewal", 604_800), now())
            .await
            .unwrap();
        db.clear_lifecycle_watermarks(ORG, "certificate", "cert:1")
            .await
            .unwrap();
        assert!(db
            .get_lifecycle_watermarks(ORG, "certificate", "cert:1")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn claiming_a_delivery_leases_it_away_from_a_second_worker() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_lifecycle_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();

        let first = db.claim_lifecycle_deliveries(10, 60, now()).await.unwrap();
        assert_eq!(first.len(), 1);
        let second = db.claim_lifecycle_deliveries(10, 60, now()).await.unwrap();
        assert!(second.is_empty(), "a leased delivery must not be re-claimed");

        // …and the lease expires, so a crashed worker cannot wedge the queue.
        let later = now() + chrono::Duration::seconds(120);
        let third = db.claim_lifecycle_deliveries(10, 60, later).await.unwrap();
        assert_eq!(third.len(), 1, "an expired lease must become claimable");
    }

    #[tokio::test]
    async fn a_delivered_row_is_never_claimed_again() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_lifecycle_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        db.mark_lifecycle_delivered("del:1", now()).await.unwrap();
        let later = now() + chrono::Duration::days(7);
        assert!(db
            .claim_lifecycle_deliveries(10, 60, later)
            .await
            .unwrap()
            .is_empty());
        let stored = &db.list_lifecycle_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.state, "delivered");
        assert!(stored.delivered_at.is_some());
    }

    #[tokio::test]
    async fn parking_counts_the_attempt_and_defers_the_retry() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_lifecycle_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        let retry_at = now() + chrono::Duration::minutes(5);
        db.park_lifecycle_delivery("del:1", retry_at, "502 from endpoint", now())
            .await
            .unwrap();

        let stored = &db.list_lifecycle_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.attempts, 1);
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.last_error.as_deref(), Some("502 from endpoint"));
        assert!(db
            .claim_lifecycle_deliveries(10, 60, now())
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.claim_lifecycle_deliveries(10, 60, retry_at)
                .await
                .unwrap()
                .len(),
            1,
        );
    }

    #[tokio::test]
    async fn a_dead_letter_is_kept_for_an_operator_to_see() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_lifecycle_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        db.dead_letter_lifecycle_delivery("del:1", "endpoint gone", now())
            .await
            .unwrap();
        let stored = &db.list_lifecycle_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.state, "dead_lettered");
        assert_eq!(stored.last_error.as_deref(), Some("endpoint gone"));
        assert!(db
            .claim_lifecycle_deliveries(10, 60, now() + chrono::Duration::days(30))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_non_json_payload_is_refused_before_it_reaches_a_subscriber() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        let mut broken = delivery("del:1", "hook:1");
        broken.payload_json = "not json".into();
        assert!(db.enqueue_lifecycle_delivery(&broken).await.is_err());
    }

    #[tokio::test]
    async fn recording_an_attempt_reports_success_and_failure_distinctly() {
        let db = seeded_db().await;
        db.upsert_lifecycle_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.record_lifecycle_hook_attempt(ORG, "hook:1", now(), Some("connection refused"))
            .await
            .unwrap();
        let stored = db.get_lifecycle_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert_eq!(stored.last_error.as_deref(), Some("connection refused"));
        assert_eq!(stored.last_delivered_at, None);

        db.record_lifecycle_hook_attempt(ORG, "hook:1", now(), None)
            .await
            .unwrap();
        let stored = db.get_lifecycle_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert_eq!(stored.last_error, None);
        assert!(stored.last_delivered_at.is_some());
    }
}
