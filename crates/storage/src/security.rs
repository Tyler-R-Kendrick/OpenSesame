//! Persistence for the security-event feed (ADR 0074, ADR 0080).
//!
//! Four concerns, deliberately kept apart:
//!
//! - [`StoredSecurityHook`] — who subscribes, to which events, at what
//!   severity, and where it is delivered. Sealed material — a Standard
//!   Webhooks signing secret or a `PagerDuty` routing key — lives in a sealed
//!   column group and never renders through `Debug`.
//! - [`StoredLifecycleWatermark`] — how far up each expiry ladder a subject has
//!   been reported, so a rung fires exactly once.
//! - [`StoredBreachFinding`] — what the breach scanner has already reported,
//!   and whether it still reproduces. A watermark counts up; a finding can go
//!   away, and that transition is itself an event.
//! - [`StoredSecurityDelivery`] — the outbound ledger, with the ADR 0039 saga
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

/// Seal scope for a hook's sealed material — a Standard Webhooks signing
/// secret, or a `PagerDuty` routing key. Distinct from every Certificate
/// Manager scope, so a hook secret cannot be opened as a signing key even if
/// rows were moved between tables.
///
/// The *value* is deliberately still `lifecycle_hook_secret` even though the
/// constant and its table were renamed. A seal scope is bound into the AAD of
/// every blob sealed under it: changing the string would make every secret
/// registered before this rename permanently unopenable, which is a migration
/// disguised as a tidy-up.
pub const SECURITY_HOOK_SECRET_SCOPE: &str = "lifecycle_hook_secret";

/// Deliveries handed out in one claim.
pub const DELIVERY_BATCH_LIMIT: usize = 32;

/// A registered security-event subscription. The sealed material never renders
/// through `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredSecurityHook {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    /// Frozen event types from any family, or a family wildcard
    /// (`lifecycle.*`, `breach.*`).
    pub event_types: Vec<String>,
    /// `webhook`, `internal`, `alertmanager`, or `pagerduty`.
    pub delivery: String,
    /// Absolute `https://` endpoint for every outbound delivery; `None` for an
    /// internal responder.
    pub endpoint_url: Option<String>,
    /// Platform responder id when `delivery` is `internal`.
    pub responder: Option<String>,
    /// `None` means every subject kind.
    pub subject_kinds: Option<Vec<String>>,
    /// Severity floor as a wire name (`info`|`warning`|`error`|`critical`).
    /// `info` admits everything, which is what a row written before severity
    /// floors existed carries.
    pub severity_min: String,
    pub enabled: bool,
    pub sealed_secret: Option<SealedCertificateMaterial>,
    pub last_delivered_at: Option<String>,
    pub last_error: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredSecurityHook {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredSecurityHook")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("name", &self.name)
            .field("event_types", &self.event_types)
            .field("delivery", &self.delivery)
            .field("endpoint_url", &self.endpoint_url)
            .field("responder", &self.responder)
            .field("subject_kinds", &self.subject_kinds)
            .field("severity_min", &self.severity_min)
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
pub struct StoredSecurityDelivery {
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

fn hook_from_row(row: &SqliteRow) -> anyhow::Result<StoredSecurityHook> {
    let event_types_json: String = row.get("event_types_json");
    let subject_kinds_json: Option<String> = row.get("subject_kinds_json");
    Ok(StoredSecurityHook {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        event_types: serde_json::from_str(&event_types_json)
            .context("security hook event_types_json is not a JSON array of strings")?,
        delivery: row.get("delivery"),
        endpoint_url: row.get("endpoint_url"),
        responder: row.get("responder"),
        subject_kinds: subject_kinds_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .context("security hook subject_kinds_json is not a JSON array of strings")?,
        severity_min: row.get("severity_min"),
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

fn delivery_from_row(row: &SqliteRow) -> StoredSecurityDelivery {
    StoredSecurityDelivery {
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

/// Wire value for a finding that currently reproduces.
pub const BREACH_FINDING_OPEN: &str = "open";
/// Wire value for a finding that has stopped reproducing.
pub const BREACH_FINDING_CLEARED: &str = "cleared";

/// One breach finding: a subject, a corpus, and whether the match still holds.
///
/// No field can carry a value, and none carries anything derived from one
/// either. There is deliberately no column for a hash or a hash prefix: a
/// stored SHA-1 of a password is a crackable artifact, and keeping one to save
/// a re-check next pass would be a bad trade for a system whose whole claim is
/// that it does not hold recoverable copies of what it protects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBreachFinding {
    pub organization_id: String,
    pub subject_kind: String,
    pub subject_id: String,
    /// Which corpus reported it.
    pub source: String,
    /// Which finding within the subject: a published breach name for a
    /// disclosure, empty for a password-corpus match.
    pub reference: String,
    pub severity: String,
    /// Corpus occurrence count for a password match. A property of the corpus.
    pub occurrences: Option<i64>,
    /// [`BREACH_FINDING_OPEN`] or [`BREACH_FINDING_CLEARED`].
    pub state: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub cleared_at: Option<String>,
}

fn breach_finding_from_row(row: &SqliteRow) -> StoredBreachFinding {
    StoredBreachFinding {
        organization_id: row.get("organization_id"),
        subject_kind: row.get("subject_kind"),
        subject_id: row.get("subject_id"),
        source: row.get("source"),
        reference: row.get("reference"),
        severity: row.get("severity"),
        occurrences: row.get("occurrences"),
        state: row.get("state"),
        first_seen_at: row.get("first_seen_at"),
        last_seen_at: row.get("last_seen_at"),
        cleared_at: row.get("cleared_at"),
    }
}

impl Db {
    // —— tenants ——————————————————————————————————————————————————

    /// Every organization id in the tenant registry, ordered.
    ///
    /// The lifecycle scanner's tick needs this to sweep more than the single
    /// organization the gateway is configured with; without it a second
    /// tenant's certificates are only ever scanned when someone calls the
    /// on-demand route by hand.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_organization_ids(&self) -> anyhow::Result<Vec<String>> {
        let rows = sqlx::query("SELECT id FROM organizations ORDER BY id")
            .fetch_all(&self.pool)
            .await
            .context("list organization ids")?;
        Ok(rows.iter().map(|row| row.get::<String, _>("id")).collect())
    }

    // —— hooks ————————————————————————————————————————————————————

    /// Create or replace a subscription. `version` advances on every write so
    /// a concurrent editor's read is detectably stale.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed group is malformed, the JSON columns
    /// are not arrays, or the row violates a schema `CHECK`.
    pub async fn upsert_security_hook(&self, hook: &StoredSecurityHook) -> anyhow::Result<()> {
        validate_optional_sealed_material(hook.sealed_secret.as_ref())?;
        let event_types_json =
            serde_json::to_string(&hook.event_types).context("encode security hook event types")?;
        validate_json_document(&event_types_json, "security hook event types")?;
        let subject_kinds_json = hook
            .subject_kinds
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .context("encode security hook subject kinds")?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(hook.sealed_secret.as_ref());
        sqlx::query(
            "INSERT INTO security_hooks (id, organization_id, name, event_types_json, delivery, endpoint_url, responder, subject_kinds_json, severity_min, enabled, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, last_delivered_at, last_error, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, event_types_json = excluded.event_types_json, \
               delivery = excluded.delivery, endpoint_url = excluded.endpoint_url, responder = excluded.responder, \
               subject_kinds_json = excluded.subject_kinds_json, severity_min = excluded.severity_min, \
               enabled = excluded.enabled, \
               sealed_secret_key_id = excluded.sealed_secret_key_id, sealed_secret_ciphertext = excluded.sealed_secret_ciphertext, \
               sealed_secret_nonce = excluded.sealed_secret_nonce, sealed_secret_aad_digest = excluded.sealed_secret_aad_digest, \
               version = security_hooks.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&hook.id)
        .bind(&hook.organization_id)
        .bind(&hook.name)
        .bind(&event_types_json)
        .bind(&hook.delivery)
        .bind(&hook.endpoint_url)
        .bind(&hook.responder)
        .bind(&subject_kinds_json)
        .bind(&hook.severity_min)
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
        .context("upsert security hook")?;
        Ok(())
    }

    /// Every subscription for an organization, newest name order.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row cannot be decoded.
    pub async fn list_security_hooks(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredSecurityHook>> {
        let rows =
            sqlx::query("SELECT * FROM security_hooks WHERE organization_id = ? ORDER BY name, id")
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await
                .context("list security hooks")?;
        rows.iter().map(hook_from_row).collect()
    }

    /// One subscription by id, scoped to its organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row cannot be decoded.
    pub async fn get_security_hook(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<StoredSecurityHook>> {
        let row = sqlx::query("SELECT * FROM security_hooks WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("get security hook")?;
        row.as_ref().map(hook_from_row).transpose()
    }

    /// Remove a subscription and, by cascade, its queued deliveries.
    ///
    /// # Errors
    ///
    /// Returns an error when the delete fails.
    pub async fn delete_security_hook(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM security_hooks WHERE organization_id = ? AND id = ?")
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
    pub async fn record_security_hook_attempt(
        &self,
        organization_id: &str,
        id: &str,
        at: DateTime<Utc>,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE security_hooks SET last_delivered_at = ?, last_error = ?, updated_at = ? \
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

    /// Claim one track's rung by advancing its watermark.
    ///
    /// Returns `true` when this caller advanced it, and `false` when the rung
    /// was already recorded — by an earlier pass, or by another gateway process
    /// racing the same scan. The table's own comment says a rung fires exactly
    /// once; this is what makes that true across processes, because the write
    /// is the claim rather than a note taken after the fact. A caller that acts
    /// on the subject must act only when it won (ADR 0073, ADR 0074).
    ///
    /// The `WHERE` mirrors `newly_crossed` + `Watermarks::effective` exactly: a
    /// rung is new when the subject's expiry changed (the ladder reset) or the
    /// incoming threshold is strictly further down the ladder. Any other write
    /// is a duplicate and claims nothing.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails or violates the track/stage
    /// `CHECK` that keeps the two ladders disjoint.
    pub async fn record_lifecycle_watermark(
        &self,
        mark: &StoredLifecycleWatermark,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let now = now.to_rfc3339();
        let advanced = sqlx::query(
            "INSERT INTO lifecycle_watermarks (organization_id, subject_kind, subject_id, track, stage, threshold_seconds, expires_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, subject_kind, subject_id, track) DO UPDATE SET \
               stage = excluded.stage, threshold_seconds = excluded.threshold_seconds, \
               expires_at = excluded.expires_at, updated_at = excluded.updated_at \
             WHERE lifecycle_watermarks.expires_at <> excluded.expires_at \
                OR excluded.threshold_seconds < lifecycle_watermarks.threshold_seconds",
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
        .context("record lifecycle watermark")?
        .rows_affected();
        Ok(advanced == 1)
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
    pub async fn enqueue_security_delivery(
        &self,
        delivery: &StoredSecurityDelivery,
    ) -> anyhow::Result<()> {
        validate_json_document(&delivery.payload_json, "lifecycle delivery payload")?;
        sqlx::query(
            "INSERT INTO security_deliveries (id, organization_id, hook_id, event_type, subject_kind, subject_id, payload_json, state, attempts, available_at, last_error, delivered_at, created_at, updated_at) \
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
    pub async fn claim_security_deliveries(
        &self,
        limit: usize,
        lease_seconds: i64,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<StoredSecurityDelivery>> {
        let mut transaction = self.pool.begin().await.context("begin delivery claim")?;
        let rows = sqlx::query(
            "SELECT * FROM security_deliveries \
             WHERE state = 'pending' AND (available_at IS NULL OR available_at <= ?) \
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(i64::try_from(limit.min(DELIVERY_BATCH_LIMIT)).unwrap_or(1))
        .fetch_all(&mut *transaction)
        .await
        .context("claim lifecycle deliveries")?;

        let lease_until = (now + chrono::Duration::seconds(lease_seconds.max(1))).to_rfc3339();
        let claimed: Vec<StoredSecurityDelivery> = rows.iter().map(delivery_from_row).collect();
        for delivery in &claimed {
            sqlx::query("UPDATE security_deliveries SET available_at = ? WHERE id = ?")
                .bind(&lease_until)
                .bind(&delivery.id)
                .execute(&mut *transaction)
                .await
                .context("lease lifecycle delivery")?;
        }
        transaction
            .commit()
            .await
            .context("commit delivery claim")?;
        Ok(claimed)
    }

    /// Mark a delivery delivered.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn mark_security_delivered(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let now = now.to_rfc3339();
        sqlx::query(
            "UPDATE security_deliveries SET state = 'delivered', delivered_at = ?, \
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
    pub async fn park_security_delivery(
        &self,
        id: &str,
        retry_at: DateTime<Utc>,
        error: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE security_deliveries SET attempts = attempts + 1, available_at = ?, \
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
    pub async fn dead_letter_security_delivery(
        &self,
        id: &str,
        error: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE security_deliveries SET state = 'dead_lettered', attempts = attempts + 1, \
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
    pub async fn list_security_deliveries(
        &self,
        organization_id: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredSecurityDelivery>> {
        let rows = sqlx::query(
            "SELECT * FROM security_deliveries WHERE organization_id = ? \
             ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(organization_id)
        .bind(i64::try_from(limit.clamp(1, 500)).unwrap_or(50))
        .fetch_all(&self.pool)
        .await
        .context("list lifecycle deliveries")?;
        Ok(rows.iter().map(delivery_from_row).collect())
    }

    // —— breach findings ——————————————————————————————————————————

    /// Record that a finding currently reproduces.
    ///
    /// Returns `true` when this call is the one that *opened* it — a finding
    /// never seen before, or one that had been cleared and has come back. That
    /// return is the publish gate: a breach that reproduces on every pass must
    /// produce one event, not one per minute, and two gateway processes
    /// scanning concurrently must not both publish it.
    ///
    /// The claim and the refresh are separate writes on purpose. The claim is
    /// conditional, so exactly one caller can win it; the refresh is
    /// unconditional, so `last_seen_at` advances on every pass and a finding
    /// that stops reproducing is detectable as stale.
    ///
    /// # Errors
    ///
    /// Returns an error when either write fails or violates a `CHECK`.
    pub async fn record_breach_finding(
        &self,
        finding: &StoredBreachFinding,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let now = now.to_rfc3339();
        let opened = sqlx::query(
            "INSERT INTO breach_findings (organization_id, subject_kind, subject_id, source, reference, severity, occurrences, state, first_seen_at, last_seen_at, cleared_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL) \
             ON CONFLICT(organization_id, subject_kind, subject_id, source, reference) DO UPDATE SET \
               severity = excluded.severity, occurrences = excluded.occurrences, \
               state = 'open', cleared_at = NULL, \
               first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at \
             WHERE breach_findings.state = 'cleared'",
        )
        .bind(&finding.organization_id)
        .bind(&finding.subject_kind)
        .bind(&finding.subject_id)
        .bind(&finding.source)
        .bind(&finding.reference)
        .bind(&finding.severity)
        .bind(finding.occurrences)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .context("record breach finding")?
        .rows_affected();

        sqlx::query(
            "UPDATE breach_findings SET last_seen_at = ?, severity = ?, occurrences = ? \
             WHERE organization_id = ? AND subject_kind = ? AND subject_id = ? \
               AND source = ? AND reference = ? AND state = 'open'",
        )
        .bind(&now)
        .bind(&finding.severity)
        .bind(finding.occurrences)
        .bind(&finding.organization_id)
        .bind(&finding.subject_kind)
        .bind(&finding.subject_id)
        .bind(&finding.source)
        .bind(&finding.reference)
        .execute(&self.pool)
        .await
        .context("refresh breach finding")?;

        Ok(opened == 1)
    }

    /// Mark a finding as no longer reproducing.
    ///
    /// Returns `true` only on the transition, so the clear publishes once and
    /// resolves whatever alert the finding opened.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn clear_breach_finding(
        &self,
        organization_id: &str,
        subject_kind: &str,
        subject_id: &str,
        source: &str,
        reference: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let cleared = sqlx::query(
            "UPDATE breach_findings SET state = 'cleared', cleared_at = ? \
             WHERE organization_id = ? AND subject_kind = ? AND subject_id = ? \
               AND source = ? AND reference = ? AND state = 'open'",
        )
        .bind(now.to_rfc3339())
        .bind(organization_id)
        .bind(subject_kind)
        .bind(subject_id)
        .bind(source)
        .bind(reference)
        .execute(&self.pool)
        .await
        .context("clear breach finding")?
        .rows_affected();
        Ok(cleared == 1)
    }

    /// Every finding in an organization that still reproduces.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_open_breach_findings(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredBreachFinding>> {
        let rows = sqlx::query(
            "SELECT * FROM breach_findings WHERE organization_id = ? AND state = 'open' \
             ORDER BY subject_kind, subject_id, source, reference",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await
        .context("list open breach findings")?;
        Ok(rows.iter().map(breach_finding_from_row).collect())
    }

    /// Findings in an organization, most recently seen first.
    ///
    /// Cleared rows are included: an operator reading the ledger needs to see
    /// that something *was* exposed and has since been rotated, not just what
    /// is exposed right now.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_breach_findings(
        &self,
        organization_id: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<StoredBreachFinding>> {
        let rows = sqlx::query(
            "SELECT * FROM breach_findings WHERE organization_id = ? \
             ORDER BY last_seen_at DESC, subject_kind, subject_id LIMIT ?",
        )
        .bind(organization_id)
        .bind(i64::try_from(limit).unwrap_or(i64::MAX))
        .fetch_all(&self.pool)
        .await
        .context("list breach findings")?;
        Ok(rows.iter().map(breach_finding_from_row).collect())
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

    /// A migrated database with `ORG` present in `organizations`.
    ///
    /// The lifecycle tables carry no organizations foreign key — see the note
    /// in `migrations/0017_lifecycle_hooks.sql` — so this is not required to
    /// make the writes succeed. It is here so the tests exercise the shape a
    /// real tenant has rather than an id belonging to nothing.
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

    /// A migrated database with no tenant row at all — the nil-organization
    /// deployment the missing foreign key exists to keep working.
    async fn unseeded_db() -> Db {
        Db::connect_memory().await.unwrap()
    }

    fn webhook_hook(id: &str, name: &str) -> StoredSecurityHook {
        StoredSecurityHook {
            id: id.into(),
            organization_id: ORG.into(),
            name: name.into(),
            event_types: vec!["lifecycle.renewal.due".into()],
            delivery: "webhook".into(),
            endpoint_url: Some("https://hooks.example/expiry".into()),
            responder: None,
            subject_kinds: Some(vec!["certificate".into()]),
            severity_min: "info".into(),
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

    fn internal_hook(id: &str, name: &str) -> StoredSecurityHook {
        StoredSecurityHook {
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

    fn delivery(id: &str, hook_id: &str) -> StoredSecurityDelivery {
        StoredSecurityDelivery {
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
            "security_hooks",
            "lifecycle_watermarks",
            "security_deliveries",
        ] {
            sqlx::query(&format!("SELECT 1 FROM {table} LIMIT 0"))
                .execute(db.pool())
                .await
                .unwrap_or_else(|error| panic!("{table} is missing: {error}"));
        }
    }

    #[tokio::test]
    async fn organization_ids_list_every_tenant() {
        let db = seeded_db().await;
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind("org:second")
            .bind("Second")
            .bind(NOW)
            .execute(db.pool())
            .await
            .unwrap();
        assert_eq!(
            db.list_organization_ids().await.unwrap(),
            vec![ORG.to_string(), "org:second".to_string()],
        );
    }

    #[tokio::test]
    async fn lifecycle_rows_persist_for_an_organization_with_no_tenant_row() {
        // The gateway's `connection_organization` falls back to the nil UUID
        // when no demo bootstrap exists. An organizations foreign key here
        // would make the scanner refuse to record anything in exactly those
        // deployments, silently stopping the rotations they run today.
        let db = unseeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .expect("a hook must persist without a tenant row");
        db.record_lifecycle_watermark(&watermark("renewal", "renewal", 1), now())
            .await
            .expect("a watermark must persist without a tenant row");
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .expect("a delivery must persist without a tenant row");
    }

    #[tokio::test]
    async fn hooks_round_trip_and_upsert_advances_the_version() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        let stored = db
            .get_security_hook(ORG, "hook:1")
            .await
            .unwrap()
            .expect("hook is stored");
        assert_eq!(stored.event_types, vec!["lifecycle.renewal.due"]);
        assert_eq!(stored.subject_kinds, Some(vec!["certificate".into()]));
        assert_eq!(stored.version, 1);
        assert!(stored.sealed_secret.is_some());

        let mut edited = webhook_hook("hook:1", "expiry");
        edited.enabled = false;
        db.upsert_security_hook(&edited).await.unwrap();
        let stored = db.get_security_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert!(!stored.enabled);
        assert_eq!(stored.version, 2, "an edit must advance the version");
    }

    #[tokio::test]
    async fn a_hook_is_scoped_to_its_organization() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        assert!(db
            .get_security_hook("org:other", "hook:1")
            .await
            .unwrap()
            .is_none());
        assert!(db
            .list_security_hooks("org:other")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_webhook_hook_without_an_endpoint_is_refused() {
        let db = seeded_db().await;
        let mut broken = webhook_hook("hook:1", "expiry");
        broken.endpoint_url = None;
        assert!(
            db.upsert_security_hook(&broken).await.is_err(),
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
            db.upsert_security_hook(&broken).await.is_err(),
            "an in-process responder signs nothing and must store nothing",
        );
    }

    #[tokio::test]
    async fn an_internal_hook_round_trips() {
        let db = seeded_db().await;
        db.upsert_security_hook(&internal_hook("hook:rot", "rotation"))
            .await
            .unwrap();
        let stored = db
            .get_security_hook(ORG, "hook:rot")
            .await
            .unwrap()
            .unwrap();
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
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        assert!(db.delete_security_hook(ORG, "hook:1").await.unwrap());
        assert!(db
            .list_security_deliveries(ORG, 10)
            .await
            .unwrap()
            .is_empty());
        assert!(!db.delete_security_hook(ORG, "hook:1").await.unwrap());
    }

    /// The write is the claim: a rung already recorded advances nothing, so a
    /// second caller learns it lost and must not act on the subject.
    #[tokio::test]
    async fn a_recorded_rung_is_claimed_exactly_once() {
        let db = seeded_db().await;
        let rung = watermark("renewal", "renewal", 604_800);

        assert!(
            db.record_lifecycle_watermark(&rung, now()).await.unwrap(),
            "the first caller claims the rung"
        );
        assert!(
            !db.record_lifecycle_watermark(&rung, now()).await.unwrap(),
            "an identical rung claims nothing"
        );
    }

    /// Descending the ladder is a new rung; climbing back up is not. This
    /// mirrors `newly_crossed`, which fires a stage only while its threshold is
    /// strictly below the watermark.
    #[tokio::test]
    async fn only_a_lower_threshold_claims_the_next_rung() {
        let db = seeded_db().await;
        assert!(db
            .record_lifecycle_watermark(&watermark("alert", "notice", 2_592_000), now())
            .await
            .unwrap());

        assert!(
            db.record_lifecycle_watermark(&watermark("alert", "warning", 604_800), now())
                .await
                .unwrap(),
            "a threshold further down the ladder is a new rung"
        );
        assert!(
            !db.record_lifecycle_watermark(&watermark("alert", "notice", 2_592_000), now())
                .await
                .unwrap(),
            "a threshold already passed claims nothing"
        );
    }

    /// A renewed subject resets its ladder, so the same threshold claims again
    /// against the new expiry — matching `Watermarks::effective`, which ignores
    /// a watermark recorded for a different `expires_at`.
    #[tokio::test]
    async fn a_new_expiry_resets_the_ladder() {
        let db = seeded_db().await;
        let first = watermark("renewal", "renewal", 604_800);
        assert!(db.record_lifecycle_watermark(&first, now()).await.unwrap());
        assert!(!db.record_lifecycle_watermark(&first, now()).await.unwrap());

        let mut renewed = first.clone();
        renewed.expires_at = "2027-09-30T00:00:00+00:00".into();
        assert!(
            db.record_lifecycle_watermark(&renewed, now())
                .await
                .unwrap(),
            "a new expiry is a new ladder, so the rung claims again"
        );
    }

    /// Two processes racing one rung: exactly one may act. This is the defect
    /// the claim exists for — without it both renew the same certificate.
    #[tokio::test]
    async fn concurrent_callers_claim_a_rung_once() {
        let db = seeded_db().await;
        let rung = watermark("renewal", "renewal", 604_800);

        let (first, second) = tokio::join!(
            db.record_lifecycle_watermark(&rung, now()),
            db.record_lifecycle_watermark(&rung, now())
        );
        let won = usize::from(first.unwrap()) + usize::from(second.unwrap());
        assert_eq!(won, 1, "exactly one caller may claim the rung");
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
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();

        let first = db.claim_security_deliveries(10, 60, now()).await.unwrap();
        assert_eq!(first.len(), 1);
        let second = db.claim_security_deliveries(10, 60, now()).await.unwrap();
        assert!(
            second.is_empty(),
            "a leased delivery must not be re-claimed"
        );

        // …and the lease expires, so a crashed worker cannot wedge the queue.
        let later = now() + chrono::Duration::seconds(120);
        let third = db.claim_security_deliveries(10, 60, later).await.unwrap();
        assert_eq!(third.len(), 1, "an expired lease must become claimable");
    }

    #[tokio::test]
    async fn a_delivered_row_is_never_claimed_again() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        db.mark_security_delivered("del:1", now()).await.unwrap();
        let later = now() + chrono::Duration::days(7);
        assert!(db
            .claim_security_deliveries(10, 60, later)
            .await
            .unwrap()
            .is_empty());
        let stored = &db.list_security_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.state, "delivered");
        assert!(stored.delivered_at.is_some());
    }

    #[tokio::test]
    async fn parking_counts_the_attempt_and_defers_the_retry() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        let retry_at = now() + chrono::Duration::minutes(5);
        db.park_security_delivery("del:1", retry_at, "502 from endpoint", now())
            .await
            .unwrap();

        let stored = &db.list_security_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.attempts, 1);
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.last_error.as_deref(), Some("502 from endpoint"));
        assert!(db
            .claim_security_deliveries(10, 60, now())
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.claim_security_deliveries(10, 60, retry_at)
                .await
                .unwrap()
                .len(),
            1,
        );
    }

    #[tokio::test]
    async fn a_dead_letter_is_kept_for_an_operator_to_see() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.enqueue_security_delivery(&delivery("del:1", "hook:1"))
            .await
            .unwrap();
        db.dead_letter_security_delivery("del:1", "endpoint gone", now())
            .await
            .unwrap();
        let stored = &db.list_security_deliveries(ORG, 10).await.unwrap()[0];
        assert_eq!(stored.state, "dead_lettered");
        assert_eq!(stored.last_error.as_deref(), Some("endpoint gone"));
        assert!(db
            .claim_security_deliveries(10, 60, now() + chrono::Duration::days(30))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_non_json_payload_is_refused_before_it_reaches_a_subscriber() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        let mut broken = delivery("del:1", "hook:1");
        broken.payload_json = "not json".into();
        assert!(db.enqueue_security_delivery(&broken).await.is_err());
    }

    #[tokio::test]
    async fn recording_an_attempt_reports_success_and_failure_distinctly() {
        let db = seeded_db().await;
        db.upsert_security_hook(&webhook_hook("hook:1", "expiry"))
            .await
            .unwrap();
        db.record_security_hook_attempt(ORG, "hook:1", now(), Some("connection refused"))
            .await
            .unwrap();
        let stored = db.get_security_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert_eq!(stored.last_error.as_deref(), Some("connection refused"));
        assert_eq!(stored.last_delivered_at, None);

        db.record_security_hook_attempt(ORG, "hook:1", now(), None)
            .await
            .unwrap();
        let stored = db.get_security_hook(ORG, "hook:1").await.unwrap().unwrap();
        assert_eq!(stored.last_error, None);
        assert!(stored.last_delivered_at.is_some());
    }

    // —— breach findings ——————————————————————————————————————————

    fn finding(subject_id: &str, reference: &str) -> StoredBreachFinding {
        StoredBreachFinding {
            organization_id: ORG.into(),
            subject_kind: "store_path".into(),
            subject_id: subject_id.into(),
            source: "hibp_passwords".into(),
            reference: reference.into(),
            severity: "critical".into(),
            occurrences: Some(42),
            state: BREACH_FINDING_OPEN.into(),
            first_seen_at: NOW.into(),
            last_seen_at: NOW.into(),
            cleared_at: None,
        }
    }

    fn at(raw: &str) -> DateTime<Utc> {
        raw.parse().unwrap()
    }

    #[tokio::test]
    async fn a_finding_opens_once_however_often_it_reproduces() {
        let db = unseeded_db().await;
        let row = finding("Dev/api-token", "");
        assert!(db.record_breach_finding(&row, at(NOW)).await.unwrap());
        for pass in 1..4 {
            assert!(
                !db.record_breach_finding(&row, at("2026-08-30T00:05:00+00:00"))
                    .await
                    .unwrap(),
                "pass {pass} re-published a finding that was already open",
            );
        }
    }

    #[tokio::test]
    async fn every_pass_refreshes_the_sighting_even_when_it_does_not_publish() {
        let db = unseeded_db().await;
        let row = finding("Dev/api-token", "");
        db.record_breach_finding(&row, at(NOW)).await.unwrap();
        db.record_breach_finding(&row, at("2026-08-31T00:00:00+00:00"))
            .await
            .unwrap();
        let open = db.list_open_breach_findings(ORG).await.unwrap();
        assert_eq!(open[0].last_seen_at, "2026-08-31T00:00:00+00:00");
        assert_eq!(
            open[0].first_seen_at, NOW,
            "the first sighting must not move",
        );
    }

    #[tokio::test]
    async fn clearing_reports_only_the_transition() {
        let db = unseeded_db().await;
        let row = finding("Dev/api-token", "");
        db.record_breach_finding(&row, at(NOW)).await.unwrap();
        let cleared = db
            .clear_breach_finding(
                ORG,
                "store_path",
                "Dev/api-token",
                "hibp_passwords",
                "",
                at(NOW),
            )
            .await
            .unwrap();
        assert!(cleared);
        assert!(
            !db.clear_breach_finding(
                ORG,
                "store_path",
                "Dev/api-token",
                "hibp_passwords",
                "",
                at(NOW)
            )
            .await
            .unwrap(),
            "a second clear must not re-publish",
        );
    }

    #[tokio::test]
    async fn a_finding_that_comes_back_opens_again() {
        let db = unseeded_db().await;
        let row = finding("Dev/api-token", "");
        db.record_breach_finding(&row, at(NOW)).await.unwrap();
        db.clear_breach_finding(
            ORG,
            "store_path",
            "Dev/api-token",
            "hibp_passwords",
            "",
            at(NOW),
        )
        .await
        .unwrap();
        assert!(
            db.record_breach_finding(&row, at("2026-09-01T00:00:00+00:00"))
                .await
                .unwrap(),
            "a rotated-then-reused secret is news again",
        );
        let open = db.list_open_breach_findings(ORG).await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].cleared_at, None);
    }

    #[tokio::test]
    async fn clearing_a_finding_that_was_never_recorded_reports_nothing() {
        let db = unseeded_db().await;
        assert!(!db
            .clear_breach_finding(ORG, "store_path", "ghost", "hibp_passwords", "", at(NOW))
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn two_disclosures_about_one_subject_are_two_findings() {
        let db = unseeded_db().await;
        let mut first = finding("adobe.com", "Adobe");
        first.subject_kind = "domain".into();
        first.source = "hibp_breaches".into();
        let mut second = first.clone();
        second.reference = "Adobe2".into();
        assert!(db.record_breach_finding(&first, at(NOW)).await.unwrap());
        assert!(db.record_breach_finding(&second, at(NOW)).await.unwrap());
        assert_eq!(db.list_open_breach_findings(ORG).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_ledger_keeps_cleared_findings_but_the_open_list_does_not() {
        let db = unseeded_db().await;
        db.record_breach_finding(&finding("Dev/api-token", ""), at(NOW))
            .await
            .unwrap();
        db.clear_breach_finding(
            ORG,
            "store_path",
            "Dev/api-token",
            "hibp_passwords",
            "",
            at(NOW),
        )
        .await
        .unwrap();
        assert!(db.list_open_breach_findings(ORG).await.unwrap().is_empty());
        let ledger = db.list_breach_findings(ORG, 50).await.unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].state, BREACH_FINDING_CLEARED);
        assert_eq!(ledger[0].cleared_at.as_deref(), Some(NOW));
    }

    #[tokio::test]
    async fn findings_are_scoped_to_their_organization() {
        let db = unseeded_db().await;
        let mut other = finding("Dev/api-token", "");
        other.organization_id = "org:other".into();
        db.record_breach_finding(&finding("Dev/api-token", ""), at(NOW))
            .await
            .unwrap();
        db.record_breach_finding(&other, at(NOW)).await.unwrap();
        assert_eq!(db.list_open_breach_findings(ORG).await.unwrap().len(), 1);
        assert_eq!(
            db.list_open_breach_findings("org:other")
                .await
                .unwrap()
                .len(),
            1,
        );
    }

    #[tokio::test]
    async fn a_severity_floor_round_trips_through_a_hook_row() {
        let db = seeded_db().await;
        let mut hook = webhook_hook("hook:floor", "paging");
        hook.severity_min = "critical".into();
        db.upsert_security_hook(&hook).await.unwrap();
        let stored = db
            .get_security_hook(ORG, "hook:floor")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.severity_min, "critical");
    }

    #[tokio::test]
    async fn an_alerting_sink_stores_without_a_responder() {
        let db = seeded_db().await;
        let mut sink = webhook_hook("hook:pd", "pagerduty");
        sink.delivery = "pagerduty".into();
        sink.endpoint_url = Some("https://events.pagerduty.com/v2/enqueue".into());
        db.upsert_security_hook(&sink).await.unwrap();
        let stored = db.get_security_hook(ORG, "hook:pd").await.unwrap().unwrap();
        assert_eq!(stored.delivery, "pagerduty");
        assert_eq!(stored.responder, None);
    }
}
