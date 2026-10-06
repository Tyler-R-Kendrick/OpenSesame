//! Organization ciphers behind the Bitwarden-compatible server (ADR 0148):
//! ciphers an organization owns, the collections they sit in, and each
//! member's own folder and favourite for them. Who may read or change one is
//! decided by the server from memberships and collection access; these
//! queries do what they are told for ids already checked.

use chrono::{DateTime, Utc};
use sqlx::Row as _;

use super::accounts::bitwarden_timestamp;
use super::ciphers::{cipher_from_row, insert_cipher, placeholders, CIPHER_COLUMNS};
use super::collections::insert_collection;
use super::{BitwardenCipher, BitwardenCollection};
use crate::Db;

/// One member's own folder and favourite for an organization cipher.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BitwardenMark {
    pub folder_id: Option<String>,
    pub favorite: bool,
}

async fn link_collections(
    tx: &mut sqlx::SqliteConnection,
    cipher_id: &str,
    collection_ids: &[String],
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM bitwarden_collection_ciphers WHERE cipher_id = ?")
        .bind(cipher_id)
        .execute(&mut *tx)
        .await?;
    for collection in collection_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO bitwarden_collection_ciphers (collection_id, cipher_id) \
             VALUES (?, ?)",
        )
        .bind(collection)
        .bind(cipher_id)
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn put_mark(
    tx: &mut sqlx::SqliteConnection,
    cipher_id: &str,
    user_id: &str,
    mark: &BitwardenMark,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO bitwarden_cipher_marks (cipher_id, user_id, folder_id, favorite) \
         VALUES (?, ?, (SELECT id FROM bitwarden_folders WHERE id = ? AND user_id = ?), ?) \
         ON CONFLICT(cipher_id, user_id) DO UPDATE SET folder_id = excluded.folder_id, \
         favorite = excluded.favorite",
    )
    .bind(cipher_id)
    .bind(user_id)
    .bind(&mark.folder_id)
    .bind(user_id)
    .bind(i64::from(mark.favorite))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

impl Db {
    /// Every cipher an organization owns, trashed ones included.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_org_ciphers(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<BitwardenCipher>> {
        // Formatting interpolates only fixed column constants; external values are bound.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {CIPHER_COLUMNS} FROM bitwarden_ciphers WHERE organization_id = ? \
             ORDER BY created_at, id"
        ))
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(cipher_from_row).collect()
    }

    /// One cipher by id, whoever owns it; the caller decides who may see it.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_cipher_any(&self, id: &str) -> anyhow::Result<Option<BitwardenCipher>> {
        // Formatting interpolates only fixed column constants; external values are bound.
        // ast-grep-ignore: sql-format-injection
        let row = sqlx::query(&format!(
            "SELECT {CIPHER_COLUMNS} FROM bitwarden_ciphers WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(cipher_from_row).transpose()
    }

    /// Create an organization cipher in `collection_ids`, with its creator's
    /// own folder and favourite.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_insert_org_cipher(
        &self,
        cipher: &BitwardenCipher,
        collection_ids: &[String],
        creator: &str,
        mark: &BitwardenMark,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        insert_cipher(&mut *tx, cipher).await?;
        link_collections(&mut tx, &cipher.id, collection_ids).await?;
        put_mark(&mut tx, &cipher.id, creator, mark).await?;
        tx.commit().await?;
        Ok(())
    }

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
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let before = sqlx::query(
            "SELECT folder_id, favorite FROM bitwarden_ciphers \
             WHERE id = ? AND user_id = ? AND revision_at = ?",
        )
        .bind(&shared.id)
        .bind(user_id)
        .bind(bitwarden_timestamp(expected_revision))
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
        .bind(&shared.organization_id)
        .bind(shared.cipher_type)
        .bind(&shared.data)
        .bind(bitwarden_timestamp(shared.revision_at))
        .bind(&shared.id)
        .execute(&mut *tx)
        .await?;
        link_collections(&mut tx, &shared.id, collection_ids).await?;
        put_mark(&mut tx, &shared.id, user_id, &mark).await?;
        // Its files now count against the organization, not the sharer.
        sqlx::query("UPDATE bitwarden_attachments SET user_id = NULL WHERE cipher_id = ?")
            .bind(&shared.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Import into an organization at once: new collections, its ciphers,
    /// and `(cipher, collection)` links between them (either may be an
    /// existing collection). All of it lands or none of it does.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_import_org(
        &self,
        collections: &[BitwardenCollection],
        ciphers: &[BitwardenCipher],
        links: &[(String, String)],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        for collection in collections {
            insert_collection(&mut tx, collection).await?;
        }
        for cipher in ciphers {
            insert_cipher(&mut *tx, cipher).await?;
        }
        for (cipher, collection) in links {
            sqlx::query(
                "INSERT OR IGNORE INTO bitwarden_collection_ciphers (collection_id, cipher_id) \
                 VALUES (?, ?)",
            )
            .bind(collection)
            .bind(cipher)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Replace an organization cipher's contents while it is still at
    /// `expected_revision`.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_update_org_cipher(
        &self,
        cipher: &BitwardenCipher,
        expected_revision: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_ciphers SET cipher_type = ?, data = ?, revision_at = ? \
             WHERE id = ? AND organization_id = ? AND revision_at = ?",
        )
        .bind(cipher.cipher_type)
        .bind(&cipher.data)
        .bind(bitwarden_timestamp(cipher.revision_at))
        .bind(&cipher.id)
        .bind(&cipher.organization_id)
        .bind(bitwarden_timestamp(expected_revision))
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Put an organization cipher in exactly these collections.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_set_cipher_collections(
        &self,
        cipher_id: &str,
        collection_ids: &[String],
        revision_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        link_collections(&mut tx, cipher_id, collection_ids).await?;
        sqlx::query("UPDATE bitwarden_ciphers SET revision_at = ? WHERE id = ?")
            .bind(bitwarden_timestamp(revision_at))
            .bind(cipher_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// One member's folder and favourite for organization ciphers.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_marks(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<(String, BitwardenMark)>> {
        let rows = sqlx::query(
            "SELECT cipher_id, folder_id, favorite FROM bitwarden_cipher_marks WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| {
                (
                    row.get("cipher_id"),
                    BitwardenMark {
                        folder_id: row.get("folder_id"),
                        favorite: row.get::<i64, _>("favorite") != 0,
                    },
                )
            })
            .collect())
    }

    /// Set one member's folder and favourite for an organization cipher.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_set_mark(
        &self,
        cipher_id: &str,
        user_id: &str,
        mark: &BitwardenMark,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        put_mark(&mut tx, cipher_id, user_id, mark).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Trash (`Some`) or restore (`None`) organization ciphers already checked.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_trash_org_ciphers(
        &self,
        ids: &[String],
        deleted_at: Option<DateTime<Utc>>,
        revision_at: DateTime<Utc>,
    ) -> anyhow::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "UPDATE bitwarden_ciphers SET deleted_at = ?, revision_at = ? \
             WHERE organization_id IS NOT NULL AND id IN ({})",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql)
            .bind(deleted_at.map(bitwarden_timestamp))
            .bind(bitwarden_timestamp(revision_at));
        for id in ids {
            query = query.bind(id);
        }
        Ok(query.execute(&self.pool).await?.rows_affected())
    }

    /// Delete organization ciphers already checked.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_org_ciphers(&self, ids: &[String]) -> anyhow::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "DELETE FROM bitwarden_ciphers WHERE organization_id IS NOT NULL AND id IN ({})",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql);
        for id in ids {
            query = query.bind(id);
        }
        Ok(query.execute(&self.pool).await?.rows_affected())
    }

    /// Delete every cipher an organization owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_purge_org(&self, org_id: &str) -> anyhow::Result<u64> {
        let done = sqlx::query("DELETE FROM bitwarden_ciphers WHERE organization_id = ?")
            .bind(org_id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected())
    }

    /// Advance an organization cipher's revision date.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_touch_org_cipher(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE bitwarden_ciphers SET revision_at = ? WHERE id = ? AND organization_id IS NOT NULL",
        )
        .bind(bitwarden_timestamp(at))
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
