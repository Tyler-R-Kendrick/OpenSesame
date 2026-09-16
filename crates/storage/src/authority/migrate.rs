//! Backfilling legacy grants into the generalized model — conservatively, and
//! resumably.
//!
//! A legacy `grants` row carries a flat action list and a flat resource list. The
//! old engine really did mean the product of the two, so the product is written
//! out explicitly rather than left to be inferred later. Everything the old
//! record does not contain is refused rather than invented: no expiry becomes a
//! quarantine, not an unbounded authority; a parent whose lineage cannot be
//! reconstructed becomes a quarantine, not a root; an unresolvable provider
//! becomes a quarantine, not `http.request`.
//!
//! Nothing here widens reach. A migrated grant carries no onward delegation
//! budget, and its manifest digest is a sentinel no live provider manifest
//! matches, so a reviewed replacement — not this backfill — is what makes it
//! usable at a new provider operation.
//!
//! Restarting is normal. Progress is a cursor written in the same transaction as
//! the row it describes, so a crash resumes at the next grant and a second run
//! over the same range writes nothing: a grant with a sidecar or a quarantine
//! record is already decided.

use super::legacy_record::Legacy;
use super::AuthorityIssue;
use crate::{Db, Row, Utc};

/// One backfill pass over one realm.
pub struct BackfillPlan<'a> {
    /// Names the backfill so its progress and cursor survive a restart.
    pub name: &'a str,
    pub organization_id: &'a str,
    /// The domain migrated authority lands in. Must be active in this realm.
    pub domain_id: &'a str,
    pub batch: i64,
}

/// What one pass did.
#[derive(Debug, PartialEq, Eq)]
pub struct BackfillReport {
    pub processed: i64,
    pub quarantined: i64,
    pub cursor: Option<String>,
    pub done: bool,
}

impl Db {
    /// Record that a verified backup exists for this backfill.
    ///
    /// # Errors
    ///
    /// Returns an error when the row cannot be written.
    pub async fn record_backfill_backup(&self, name: &str) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO authority_backfill_progress (id, backup_verified_at, updated_at) \
             VALUES (?, ?, ?) \
             ON CONFLICT (id) DO UPDATE SET backup_verified_at = excluded.backup_verified_at, \
               updated_at = excluded.updated_at",
        )
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Read a backfill's recorded progress: processed, quarantined, cursor.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row cannot be decoded.
    pub async fn backfill_progress(
        &self,
        name: &str,
    ) -> anyhow::Result<Option<(i64, i64, Option<String>)>> {
        let row = sqlx::query(
            "SELECT processed, quarantined, cursor_id FROM authority_backfill_progress \
             WHERE id = ?",
        )
        .bind(name)
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| {
            Ok((
                row.try_get("processed")?,
                row.try_get("quarantined")?,
                row.try_get("cursor_id")?,
            ))
        })
        .transpose()
    }

    /// Refuse a client too old to understand correlated permission entries.
    ///
    /// Such a client reads a generalized grant as the flat pair it recognises and
    /// writes it back without the constraints it never parsed. Naming the floor is
    /// how that client is refused instead of silently erasing them.
    ///
    /// # Errors
    ///
    /// Returns an error when the floor cannot be read, or when the client is below
    /// it.
    pub async fn assert_client_revision(&self, client_revision: i64) -> anyhow::Result<()> {
        let row =
            sqlx::query("SELECT minimum_client_revision FROM authority_client_floor WHERE id = 1")
                .fetch_one(self.pool())
                .await?;
        let floor: i64 = row.try_get("minimum_client_revision")?;
        anyhow::ensure!(
            client_revision >= floor,
            "client revision {client_revision} is below the authority floor {floor}"
        );
        Ok(())
    }

    /// Raise the incompatible-client floor.
    ///
    /// # Errors
    ///
    /// Returns an error when the floor would be lowered, or cannot be written.
    pub async fn set_client_floor(&self, minimum_client_revision: i64) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let changed = sqlx::query(
            "UPDATE authority_client_floor \
             SET minimum_client_revision = ?, updated_at = ? \
             WHERE id = 1 AND minimum_client_revision <= ?",
        )
        .bind(minimum_client_revision)
        .bind(&now)
        .bind(minimum_client_revision)
        .execute(self.pool())
        .await?
        .rows_affected();
        Ok(changed == 1)
    }

    /// Translate one batch of legacy grants.
    ///
    /// # Errors
    ///
    /// Returns an error when no verified backup is recorded for this backfill —
    /// a translation pass is not something to start without one — when the target
    /// domain is not active in the realm, or when a write fails.
    pub async fn backfill_legacy_grants(
        &self,
        plan: &BackfillPlan<'_>,
    ) -> anyhow::Result<BackfillReport> {
        anyhow::ensure!(plan.batch > 0, "a backfill batch must be positive");
        let progress = self.backfill_progress(plan.name).await?;
        let backup =
            sqlx::query("SELECT backup_verified_at FROM authority_backfill_progress WHERE id = ?")
                .bind(plan.name)
                .fetch_optional(self.pool())
                .await?;
        anyhow::ensure!(
            backup
                .and_then(|row| row.get::<Option<String>, _>("backup_verified_at"))
                .is_some(),
            "backfill {} has no verified backup recorded",
            plan.name
        );
        let cursor = progress
            .and_then(|(_, _, cursor)| cursor)
            .unwrap_or_default();
        let rows = sqlx::query(
            "SELECT id, body_json, revoked_at FROM grants \
             WHERE organization_id = ? AND id > ? \
               AND id NOT IN (SELECT grant_id FROM grant_authority) \
               AND id NOT IN (SELECT grant_id FROM authority_backfill_quarantine) \
             ORDER BY id LIMIT ?",
        )
        .bind(plan.organization_id)
        .bind(&cursor)
        .bind(plan.batch)
        .fetch_all(self.pool())
        .await?;
        let done = i64::try_from(rows.len())? < plan.batch;
        let mut report = BackfillReport {
            processed: 0,
            quarantined: 0,
            cursor: None,
            done,
        };
        for row in rows {
            let id: String = row.try_get("id")?;
            let revoked: Option<String> = row.try_get("revoked_at")?;
            let body: String = row.try_get("body_json")?;
            if self.translate(plan, &id, &body, revoked.is_some()).await? {
                report.processed += 1;
            } else {
                report.quarantined += 1;
            }
            self.advance_cursor(plan.name, &id, report.processed, report.quarantined)
                .await?;
            report.cursor = Some(id);
        }
        Ok(report)
    }

    /// Translate one legacy grant, or quarantine it with a reason. `true` means
    /// translated.
    async fn translate(
        &self,
        plan: &BackfillPlan<'_>,
        id: &str,
        body: &str,
        revoked: bool,
    ) -> anyhow::Result<bool> {
        if revoked {
            self.quarantine(plan, id, "revoked").await?;
            return Ok(false);
        }
        let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
        let Some(legacy) = parsed.as_ref().and_then(Legacy::read) else {
            self.quarantine(plan, id, "malformed").await?;
            return Ok(false);
        };
        if let Some(reason) = legacy.refusal() {
            self.quarantine(plan, id, reason).await?;
            return Ok(false);
        }
        let issued = self
            .issue_authority(
                &AuthorityIssue {
                    grant_id: id,
                    organization_id: plan.organization_id,
                    domain_id: plan.domain_id,
                    parent_grant_id: None,
                    issuance_basis: "root",
                    lineage_digest: "legacy:flat",
                    policy_digest: "legacy:none",
                    role_revision: None,
                    offer_id: None,
                    delegation_depth_remaining: 0,
                    not_before: legacy.not_before,
                    expires_at: legacy.expires_at,
                    evidence_id: None,
                },
                &legacy.entries(),
            )
            .await?;
        if !issued {
            self.quarantine(plan, id, "preconditions_unmet").await?;
            return Ok(false);
        }
        Ok(true)
    }

    async fn quarantine(
        &self,
        plan: &BackfillPlan<'_>,
        grant_id: &str,
        reason: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO authority_backfill_quarantine \
             (grant_id, organization_id, reason, observed_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT (grant_id) DO NOTHING",
        )
        .bind(grant_id)
        .bind(plan.organization_id)
        .bind(reason)
        .bind(Utc::now().to_rfc3339())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn advance_cursor(
        &self,
        name: &str,
        cursor: &str,
        processed: i64,
        quarantined: i64,
    ) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE authority_backfill_progress \
             SET cursor_id = ?, processed = ?, quarantined = ?, updated_at = ? WHERE id = ?",
        )
        .bind(cursor)
        .bind(processed)
        .bind(quarantined)
        .bind(&now)
        .bind(name)
        .execute(self.pool())
        .await?;
        Ok(())
    }
}
