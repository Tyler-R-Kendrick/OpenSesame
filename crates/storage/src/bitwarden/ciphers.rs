//! Ciphers behind the Bitwarden-compatible server (ADR 0141).
//!
//! A cipher's `data` is the client's own JSON — every value in it an
//! `EncString` the server cannot open — held verbatim so a client reads back
//! exactly what it wrote. A folder a write names is resolved inside the same
//! statement, so a folder deleted mid-write leaves the cipher in "no folder"
//! rather than pointing at nothing.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use super::folders::{insert_folder, BitwardenFolder};
use crate::{Db, Row};

/// A personal cipher. `data` is the client's encrypted payload as JSON.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenCipher {
    pub id: String,
    pub user_id: String,
    pub folder_id: Option<String>,
    pub cipher_type: i64,
    pub favorite: bool,
    pub data: String,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
}

fn optional_timestamp(row: &SqliteRow, column: &str) -> anyhow::Result<Option<DateTime<Utc>>> {
    row.get::<Option<String>, _>(column)
        .as_deref()
        .map(parse_bitwarden_timestamp)
        .transpose()
}

fn cipher_from_row(row: &SqliteRow) -> anyhow::Result<BitwardenCipher> {
    Ok(BitwardenCipher {
        id: row.get("id"),
        user_id: row.get("user_id"),
        folder_id: row.get("folder_id"),
        cipher_type: row.get("cipher_type"),
        favorite: row.get::<i64, _>("favorite") != 0,
        data: row.get("data"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
        deleted_at: optional_timestamp(row, "deleted_at")?,
        archived_at: optional_timestamp(row, "archived_at")?,
    })
}

const CIPHER_COLUMNS: &str = "id, user_id, folder_id, cipher_type, favorite, data, created_at, \
     revision_at, deleted_at, archived_at";

/// `?, ?, …` for an `IN (…)` list of `count` ids.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// The caller's own folder with this id, or `NULL`: evaluated in the write.
const OWNED_FOLDER: &str =
    "(SELECT f.id FROM bitwarden_folders f WHERE f.id = ? AND f.user_id = ?)";

impl Db {
    /// Every cipher the account owns, trashed ones included.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_ciphers(&self, user_id: &str) -> anyhow::Result<Vec<BitwardenCipher>> {
        let sql = format!(
            "SELECT {CIPHER_COLUMNS} FROM bitwarden_ciphers WHERE user_id = ? ORDER BY created_at, id"
        );
        let rows = sqlx::query(&sql)
            .bind(user_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(cipher_from_row).collect()
    }

    /// One cipher, only if the account owns it.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_cipher(
        &self,
        user_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenCipher>> {
        let sql =
            format!("SELECT {CIPHER_COLUMNS} FROM bitwarden_ciphers WHERE user_id = ? AND id = ?");
        let row = sqlx::query(&sql)
            .bind(user_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(cipher_from_row).transpose()
    }

    /// The account's ciphers with these ids.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_ciphers_by_ids(
        &self,
        user_id: &str,
        ids: &[String],
    ) -> anyhow::Result<Vec<BitwardenCipher>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {CIPHER_COLUMNS} FROM bitwarden_ciphers WHERE user_id = ? AND id IN ({}) \
             ORDER BY created_at, id",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql).bind(user_id);
        for id in ids {
            query = query.bind(id);
        }
        let rows = query.fetch_all(&self.pool).await?;
        rows.iter().map(cipher_from_row).collect()
    }

    /// Create a cipher.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_insert_cipher(&self, cipher: &BitwardenCipher) -> anyhow::Result<()> {
        insert_cipher(&self.pool, cipher).await
    }

    /// Replace a cipher's contents, but only while it is still at
    /// `expected_revision` — the revision the caller read. Returns `false`,
    /// and writes nothing, when another write got there first.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_update_cipher(
        &self,
        cipher: &BitwardenCipher,
        expected_revision: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let sql = format!(
            "UPDATE bitwarden_ciphers SET folder_id = {OWNED_FOLDER}, cipher_type = ?, \
             favorite = ?, data = ?, revision_at = ? \
             WHERE id = ? AND user_id = ? AND revision_at = ?"
        );
        let done = sqlx::query(&sql)
            .bind(&cipher.folder_id)
            .bind(&cipher.user_id)
            .bind(cipher.cipher_type)
            .bind(i64::from(cipher.favorite))
            .bind(&cipher.data)
            .bind(bitwarden_timestamp(cipher.revision_at))
            .bind(&cipher.id)
            .bind(&cipher.user_id)
            .bind(bitwarden_timestamp(expected_revision))
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Import folders and ciphers in one transaction: all land or none do.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn bitwarden_import(
        &self,
        folders: &[BitwardenFolder],
        ciphers: &[BitwardenCipher],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        for folder in folders {
            insert_folder(&mut *tx, folder).await?;
        }
        for cipher in ciphers {
            insert_cipher(&mut *tx, cipher).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Move ciphers to the trash (`Some`) or restore them (`None`). Returns
    /// how many of the account's ciphers changed.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_trash_ciphers(
        &self,
        user_id: &str,
        ids: &[String],
        deleted_at: Option<DateTime<Utc>>,
        revision_at: DateTime<Utc>,
    ) -> anyhow::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "UPDATE bitwarden_ciphers SET deleted_at = ?, revision_at = ? \
             WHERE user_id = ? AND id IN ({})",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql)
            .bind(deleted_at.map(bitwarden_timestamp))
            .bind(bitwarden_timestamp(revision_at))
            .bind(user_id);
        for id in ids {
            query = query.bind(id);
        }
        Ok(query.execute(&self.pool).await?.rows_affected())
    }

    /// Move ciphers into a folder (`None` = no folder).
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_move_ciphers(
        &self,
        user_id: &str,
        ids: &[String],
        folder_id: Option<&str>,
        revision_at: DateTime<Utc>,
    ) -> anyhow::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "UPDATE bitwarden_ciphers SET folder_id = {OWNED_FOLDER}, revision_at = ? \
             WHERE user_id = ? AND id IN ({})",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql)
            .bind(folder_id)
            .bind(user_id)
            .bind(bitwarden_timestamp(revision_at))
            .bind(user_id);
        for id in ids {
            query = query.bind(id);
        }
        Ok(query.execute(&self.pool).await?.rows_affected())
    }

    /// Permanently delete ciphers. Returns how many were deleted.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_ciphers(
        &self,
        user_id: &str,
        ids: &[String],
    ) -> anyhow::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "DELETE FROM bitwarden_ciphers WHERE user_id = ? AND id IN ({})",
            placeholders(ids.len())
        );
        let mut query = sqlx::query(&sql).bind(user_id);
        for id in ids {
            query = query.bind(id);
        }
        Ok(query.execute(&self.pool).await?.rows_affected())
    }

    /// Delete every cipher and folder the account owns (Bitwarden's "purge vault").
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn bitwarden_purge(&self, user_id: &str) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM bitwarden_ciphers WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM bitwarden_folders WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn insert_cipher<'e, E>(executor: E, cipher: &BitwardenCipher) -> anyhow::Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let sql = format!(
        "INSERT INTO bitwarden_ciphers (id, user_id, folder_id, cipher_type, favorite, data, \
         created_at, revision_at, deleted_at, archived_at) \
         VALUES (?, ?, {OWNED_FOLDER}, ?, ?, ?, ?, ?, ?, ?)"
    );
    sqlx::query(&sql)
        .bind(&cipher.id)
        .bind(&cipher.user_id)
        .bind(&cipher.folder_id)
        .bind(&cipher.user_id)
        .bind(cipher.cipher_type)
        .bind(i64::from(cipher.favorite))
        .bind(&cipher.data)
        .bind(bitwarden_timestamp(cipher.created_at))
        .bind(bitwarden_timestamp(cipher.revision_at))
        .bind(cipher.deleted_at.map(bitwarden_timestamp))
        .bind(cipher.archived_at.map(bitwarden_timestamp))
        .execute(executor)
        .await?;
    Ok(())
}
