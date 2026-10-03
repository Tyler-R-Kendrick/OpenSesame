//! The keys an organization trusts to sign web-login recipes (ADR 0076 §4,
//! ADR 0159), pinned by an owner/admin or the operator and never by a recipe.
//!
//! The row is a public key and a name; the private half never reaches the
//! Host. A key id is derived from the key by the caller (`rsk_` and a digest),
//! so a request cannot pick one, and the table checks its shape. A pin and a
//! revocation each commit their audit event in the same transaction as the
//! row. Revocation is final and the row stays: the id can never be pinned
//! again, so a recipe the key signed is not quietly trusted again by a re-pin.

use sqlx::{sqlite::SqliteRow, Row};

use super::recipes::RecipeAudit;
use crate::{append_outbox_tx, Db};

/// Pinned keys one organization may hold at once, revoked ones included. A
/// bound on what a run's verification and a listing walk.
pub const MAX_SIGNERS_PER_ORGANIZATION: i64 = 32;

/// One pinned signer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRecipeSigner {
    pub organization_id: String,
    pub key_id: String,
    /// The Ed25519 public key, 64 lowercase hex characters.
    pub public_key: String,
    pub label: String,
    pub pinned_by: String,
    pub pinned_at: String,
    pub revoked_at: Option<String>,
    pub revoked_by: Option<String>,
}

/// A key to pin.
pub struct SignerPin<'a> {
    pub organization_id: &'a str,
    pub key_id: &'a str,
    pub public_key: &'a str,
    pub label: &'a str,
    pub pinned_by: &'a str,
    pub pinned_at: &'a str,
}

/// How a pin ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignerPinOutcome {
    Pinned(StoredRecipeSigner),
    /// The id is already a row: pinned, or revoked and so never pinnable again.
    Exists(StoredRecipeSigner),
    /// The organization holds [`MAX_SIGNERS_PER_ORGANIZATION`] already.
    LimitReached,
}

/// How a revocation ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignerRevokeOutcome {
    Revoked(StoredRecipeSigner),
    NotFound,
    AlreadyRevoked(StoredRecipeSigner),
}

const SIGNER_COLUMNS: &str = "organization_id, key_id, public_key, label, pinned_by, \
     pinned_at, revoked_at, revoked_by";

fn signer_from_row(row: &SqliteRow) -> anyhow::Result<StoredRecipeSigner> {
    Ok(StoredRecipeSigner {
        organization_id: row.try_get("organization_id")?,
        key_id: row.try_get("key_id")?,
        public_key: row.try_get("public_key")?,
        label: row.try_get("label")?,
        pinned_by: row.try_get("pinned_by")?,
        pinned_at: row.try_get("pinned_at")?,
        revoked_at: row.try_get("revoked_at")?,
        revoked_by: row.try_get("revoked_by")?,
    })
}

impl Db {
    /// Every signer the organization has pinned, revoked ones included, in
    /// the order they were pinned.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_web_login_recipe_signers(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredRecipeSigner>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {SIGNER_COLUMNS} FROM web_login_recipe_signers \
             WHERE organization_id = ? ORDER BY pinned_at ASC, key_id ASC"
        );
        let rows = sqlx::query(&sql)
            .bind(organization_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(signer_from_row).collect()
    }

    /// One signer, revoked or not.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn web_login_recipe_signer(
        &self,
        organization_id: &str,
        key_id: &str,
    ) -> anyhow::Result<Option<StoredRecipeSigner>> {
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {SIGNER_COLUMNS} FROM web_login_recipe_signers \
             WHERE organization_id = ? AND key_id = ?"
        );
        sqlx::query(&sql)
            .bind(organization_id)
            .bind(key_id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(signer_from_row)
            .transpose()
    }

    /// Pin a key, committing `audit` in the same transaction. An id that is
    /// already a row — pinned or revoked — is refused unchanged.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails or the table refuses the
    /// key's shape; nothing is committed.
    pub async fn pin_web_login_recipe_signer(
        &self,
        pin: &SignerPin<'_>,
        audit: &RecipeAudit<'_>,
    ) -> anyhow::Result<SignerPinOutcome> {
        let mut transaction = self.pool.begin().await?;
        let held: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM web_login_recipe_signers WHERE organization_id = ?",
        )
        .bind(pin.organization_id)
        .fetch_one(&mut *transaction)
        .await?;
        let inserted = sqlx::query(
            "INSERT INTO web_login_recipe_signers \
             (organization_id, key_id, algorithm, public_key, label, pinned_by, pinned_at) \
             SELECT ?, ?, 'ed25519', ?, ?, ?, ? WHERE ? < ? \
             ON CONFLICT(organization_id, key_id) DO NOTHING",
        )
        .bind(pin.organization_id)
        .bind(pin.key_id)
        .bind(pin.public_key)
        .bind(pin.label)
        .bind(pin.pinned_by)
        .bind(pin.pinned_at)
        .bind(held)
        .bind(MAX_SIGNERS_PER_ORGANIZATION)
        .execute(&mut *transaction)
        .await?;
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {SIGNER_COLUMNS} FROM web_login_recipe_signers \
             WHERE organization_id = ? AND key_id = ?"
        );
        let row = sqlx::query(&sql)
            .bind(pin.organization_id)
            .bind(pin.key_id)
            .fetch_optional(&mut *transaction)
            .await?
            .as_ref()
            .map(signer_from_row)
            .transpose()?;
        if inserted.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(row.map_or(SignerPinOutcome::LimitReached, SignerPinOutcome::Exists));
        }
        let row = row.ok_or_else(|| anyhow::anyhow!("pinned recipe signer vanished"))?;
        append_outbox_tx(&mut transaction, audit.event_type, audit.payload_json).await?;
        transaction.commit().await?;
        Ok(SignerPinOutcome::Pinned(row))
    }

    /// Revoke a signer, committing `audit` in the same transaction. The
    /// transition is one conditional update, so two revocations race to one
    /// winner and the loser changes and appends nothing.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails; nothing is committed.
    pub async fn revoke_web_login_recipe_signer(
        &self,
        organization_id: &str,
        key_id: &str,
        revoked_by: &str,
        revoked_at: &str,
        audit: &RecipeAudit<'_>,
    ) -> anyhow::Result<SignerRevokeOutcome> {
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE web_login_recipe_signers SET revoked_at = ?, revoked_by = ? \
             WHERE organization_id = ? AND key_id = ? AND revoked_at IS NULL",
        )
        .bind(revoked_at)
        .bind(revoked_by)
        .bind(organization_id)
        .bind(key_id)
        .execute(&mut *transaction)
        .await?;
        // ast-grep-ignore: sql-format-injection
        let sql = format!(
            "SELECT {SIGNER_COLUMNS} FROM web_login_recipe_signers \
             WHERE organization_id = ? AND key_id = ?"
        );
        let row = sqlx::query(&sql)
            .bind(organization_id)
            .bind(key_id)
            .fetch_optional(&mut *transaction)
            .await?
            .as_ref()
            .map(signer_from_row)
            .transpose()?;
        if updated.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(row.map_or(SignerRevokeOutcome::NotFound, |signer| {
                SignerRevokeOutcome::AlreadyRevoked(signer)
            }));
        }
        let row = row.ok_or_else(|| anyhow::anyhow!("revoked recipe signer vanished"))?;
        append_outbox_tx(&mut transaction, audit.event_type, audit.payload_json).await?;
        transaction.commit().await?;
        Ok(SignerRevokeOutcome::Revoked(row))
    }
}
