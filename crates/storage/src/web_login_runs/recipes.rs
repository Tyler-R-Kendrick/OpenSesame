//! The recipes a web-login run replays, and the rule that makes one of them
//! replayable (ADR 0076 §4, ADR 0159).
//!
//! `trust` is never an input. A write carries the *verification* the Host
//! performed — which pinned signer's signature checked, and a canary the
//! signed document attests — and the row's trust is derived from it here, in
//! the same transaction that re-checks the signer is still pinned and
//! unrevoked. A recipe with no verification is `candidate`, and a run never
//! replays it.
//!
//! What a run may replay is [`Db::runnable_web_login_recipe`]:
//!
//! - **verified** — a signature that checked against a signer who is pinned
//!   and not revoked *now* (the join is evaluated at read time, so revoking a
//!   key takes effect on the next run);
//! - **unexpired**;
//! - for an **unattended** run, also **canary-verified**: `trust` at least
//!   `canary_verified` and a passing canary no older than the caller's cutoff.
//!   An **attended** run, where a person is driving, needs the signature and
//!   not the canary — which is how the first canary can happen at all.
//!
//! Timestamps are compared as text, so a caller writes them all as UTC
//! RFC 3339 (`DateTime::to_rfc3339`).

use sqlx::Row;

use super::recipe_rows::{
    derive_canary, insert, read_recipe, record_from_row, update, RECIPE_COLUMNS, RUNNABLE_COLUMNS,
};
use super::REPLAYABLE_TRUST;
use crate::{append_outbox_event_in, Db};

pub use super::recipe_rows::{
    RecipeAudit, RecipeDeleteOutcome, RecipeUse, RecipeVerification, RecipeWrite,
    RecipeWriteOutcome, RunResult, RunnableRecipe, StoredRecipeRecord, MAX_LISTED_RECIPES,
};

impl Db {
    /// One recipe by origin.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn web_login_recipe(
        &self,
        organization_id: &str,
        origin: &str,
    ) -> anyhow::Result<Option<StoredRecipeRecord>> {
        read_recipe(&self.pool, organization_id, origin).await
    }

    /// The organization's recipes, by origin.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_web_login_recipes(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredRecipeRecord>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {RECIPE_COLUMNS} FROM web_login_recipes WHERE organization_id = ? \
             ORDER BY origin ASC LIMIT ?"
        );
        let rows = sqlx::query(&sql)
            .bind(organization_id)
            .bind(MAX_LISTED_RECIPES)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(record_from_row).collect()
    }

    /// Store a recipe when `expected_version` is still the stored version (0:
    /// only when none is stored), committing `audit` in the same transaction.
    /// The signer a verification names is re-checked inside it.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails; nothing is committed.
    pub async fn put_web_login_recipe_document(
        &self,
        write: &RecipeWrite<'_>,
        audit: &RecipeAudit<'_>,
    ) -> anyhow::Result<RecipeWriteOutcome> {
        anyhow::ensure!(
            write.expected_version >= 0,
            "an expected recipe version is never negative"
        );
        let mut tx = self.pool.begin().await?;
        if let Some(verification) = &write.verification {
            let pinned: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM web_login_recipe_signers \
                 WHERE organization_id = ? AND key_id = ? AND revoked_at IS NULL",
            )
            .bind(write.organization_id)
            .bind(verification.signer_key_id)
            .fetch_one(&mut *tx)
            .await?;
            if pinned == 0 {
                tx.rollback().await?;
                return Ok(RecipeWriteOutcome::SignerNotPinned);
            }
        }
        let existing = read_recipe(&mut *tx, write.organization_id, write.origin).await?;
        let canary = derive_canary(write, existing.as_ref());
        let affected = if write.expected_version == 0 {
            insert(&mut tx, write, &canary).await?
        } else {
            update(&mut tx, write, &canary).await?
        };
        if affected == 0 {
            tx.rollback().await?;
            return Ok(RecipeWriteOutcome::Conflict {
                current_version: existing.map_or(0, |row| row.version),
            });
        }
        let row = read_recipe(&mut *tx, write.organization_id, write.origin)
            .await?
            .ok_or_else(|| anyhow::anyhow!("written web-login recipe vanished"))?;
        append_outbox_event_in(
            &mut tx,
            Some(write.organization_id),
            audit.event_type,
            audit.payload_json,
        )
        .await?;
        tx.commit().await?;
        Ok(RecipeWriteOutcome::Written(Box::new(row)))
    }

    /// Delete a recipe when `expected_version` is still the stored version,
    /// committing `audit` in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails; nothing is committed.
    pub async fn delete_web_login_recipe(
        &self,
        organization_id: &str,
        origin: &str,
        expected_version: i64,
        audit: &RecipeAudit<'_>,
    ) -> anyhow::Result<RecipeDeleteOutcome> {
        let mut tx = self.pool.begin().await?;
        let deleted = sqlx::query(
            "DELETE FROM web_login_recipes \
             WHERE organization_id = ? AND origin = ? AND version = ?",
        )
        .bind(organization_id)
        .bind(origin)
        .bind(expected_version)
        .execute(&mut *tx)
        .await?;
        if deleted.rows_affected() == 0 {
            let current = read_recipe(&mut *tx, organization_id, origin).await?;
            tx.rollback().await?;
            return Ok(current.map_or(RecipeDeleteOutcome::NotFound, |row| {
                RecipeDeleteOutcome::Conflict {
                    current_version: row.version,
                }
            }));
        }
        append_outbox_event_in(
            &mut tx,
            Some(organization_id),
            audit.event_type,
            audit.payload_json,
        )
        .await?;
        tx.commit().await?;
        Ok(RecipeDeleteOutcome::Deleted)
    }

    /// The recipe a run may replay for `origin` at `now`, or `None`: absent,
    /// unverified, unexpired-no-more, signed by a key no longer pinned, or —
    /// for an unattended run — without a fresh passing canary. A refusal is
    /// the same as no recipe, because replaying one is what the ladder exists
    /// to prevent.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn runnable_web_login_recipe(
        &self,
        organization_id: &str,
        origin: &str,
        now: &str,
        usage: RecipeUse<'_>,
    ) -> anyhow::Result<Option<RunnableRecipe>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {RUNNABLE_COLUMNS}, s.public_key AS signer_public_key \
             FROM web_login_recipes r \
             JOIN web_login_recipe_signers s ON s.organization_id = r.organization_id \
               AND s.key_id = r.signer_key_id AND s.revoked_at IS NULL \
             WHERE r.organization_id = ? AND r.origin = ? AND r.document_json IS NOT NULL \
               AND r.verified_at IS NOT NULL AND r.expires_at > ?"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(origin)
            .bind(now)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let record = record_from_row(&row)?;
        if let RecipeUse::Unattended { canary_not_before } = usage {
            let proven = REPLAYABLE_TRUST.contains(&record.trust.as_str())
                && record.canary_result.as_deref() == Some("passed")
                && record
                    .canary_at
                    .as_deref()
                    .is_some_and(|at| at >= canary_not_before);
            if !proven {
                return Ok(None);
            }
        }
        Ok(Some(RunnableRecipe {
            record,
            signer_public_key: row.try_get("signer_public_key")?,
        }))
    }

    /// Record what a run proved about the exact document it replayed
    /// (`digest`): a pass makes a verified recipe `canary_verified`, a failure
    /// demotes it. A recipe replaced since the run began is not touched.
    /// Returns whether a row changed.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn record_web_login_recipe_run(
        &self,
        organization_id: &str,
        origin: &str,
        digest: &str,
        result: RunResult,
        run_id: &str,
        at: &str,
    ) -> anyhow::Result<bool> {
        let sql = match result {
            RunResult::Passed => {
                "UPDATE web_login_recipes SET canary_result = 'passed', canary_at = ?, \
                 canary_run_id = ?, canary_source = 'run', trust = 'canary_verified' \
                 WHERE organization_id = ? AND origin = ? AND digest = ? \
                 AND document_json IS NOT NULL AND verified_at IS NOT NULL"
            }
            RunResult::Failed => {
                "UPDATE web_login_recipes SET canary_result = 'failed', canary_at = ?, \
                 canary_run_id = ?, canary_source = 'run', \
                 trust = CASE WHEN trust = 'canary_verified' THEN 'candidate' ELSE trust END \
                 WHERE organization_id = ? AND origin = ? AND digest = ? \
                 AND document_json IS NOT NULL"
            }
        };
        let done = sqlx::query(sql)
            .bind(at)
            .bind(run_id)
            .bind(organization_id)
            .bind(origin)
            .bind(digest)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() > 0)
    }
}
