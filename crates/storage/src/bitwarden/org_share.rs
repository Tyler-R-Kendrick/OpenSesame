//! Atomic personal-to-organization cipher transfers and destination quota admission.

use chrono::{DateTime, Utc};
use sqlx::Row as _;

use super::accounts::bitwarden_timestamp;
use super::file_quota;
use super::org_ciphers::{link_collections, put_mark};
use super::{BitwardenCipher, BitwardenMark};
use crate::Db;

impl Db {
    /// Hand a personal cipher to an organization, re-encrypted under its key,
    /// only while it is still the sharer's at `expected_revision`. The
    /// sharer keeps their folder and favourite as their own marks.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_share_cipher(
        &self,
        user_id: &str,
        shared: &BitwardenCipher,
        expected_revision: DateTime<Utc>,
        collection_ids: &[String],
        quota: i64,
    ) -> anyhow::Result<bool> {
        self.bitwarden_share_ciphers(
            user_id,
            &[(shared.clone(), expected_revision)],
            collection_ids,
            quota,
        )
        .await
    }

    /// Share a batch atomically. The write lock serializes destination quota
    /// admission with uploads, reservations and other ownership transfers.
    ///
    /// # Errors
    ///
    /// Returns an error, rolling back every transfer, when the transaction
    /// fails or any destination would exceed its storage quota.
    pub async fn bitwarden_share_ciphers(
        &self,
        user_id: &str,
        shared: &[(BitwardenCipher, DateTime<Utc>)],
        collection_ids: &[String],
        quota: i64,
    ) -> anyhow::Result<bool> {
        let mut tx = super::policy_rules::begin_write(&self.pool).await?;
        for (cipher, expected_revision) in shared {
            let before = sqlx::query(
                "SELECT folder_id, favorite FROM bitwarden_ciphers \
                 WHERE id = ? AND user_id = ? AND revision_at = ?",
            )
            .bind(&cipher.id)
            .bind(user_id)
            .bind(bitwarden_timestamp(*expected_revision))
            .fetch_optional(&mut *tx)
            .await?;
            let Some(before) = before else {
                return Ok(false);
            };
            let mark = BitwardenMark {
                folder_id: before.get("folder_id"),
                favorite: before.get::<i64, _>("favorite") != 0,
            };
            sqlx::query(
                "UPDATE bitwarden_ciphers SET user_id = NULL, organization_id = ?, folder_id = NULL, \
                 favorite = 0, cipher_type = ?, data = ?, revision_at = ? WHERE id = ?",
            )
            .bind(&cipher.organization_id)
            .bind(cipher.cipher_type)
            .bind(&cipher.data)
            .bind(bitwarden_timestamp(cipher.revision_at))
            .bind(&cipher.id)
            .execute(&mut *tx)
            .await?;
            link_collections(&mut tx, &cipher.id, collection_ids).await?;
            put_mark(&mut tx, &cipher.id, user_id, &mark).await?;
            sqlx::query("UPDATE bitwarden_attachments SET user_id = NULL WHERE cipher_id = ?")
                .bind(&cipher.id)
                .execute(&mut *tx)
                .await?;
            // Charge actual bytes and pending reservations before commit.
            // A cipher with no file bytes may still be shared when legacy
            // files already put the destination over quota.
            let adds_bytes: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM bitwarden_attachments a \
                 LEFT JOIN bitwarden_blobs b ON b.id = a.id WHERE a.cipher_id = ? \
                 AND COALESCE(length(b.data), a.size) > 0)",
            )
            .bind(&cipher.id)
            .fetch_one(&mut *tx)
            .await?;
            if adds_bytes {
                file_quota::check_cipher(&mut tx, &cipher.id, quota).await?;
            }
        }
        tx.commit().await?;
        Ok(true)
    }
}
