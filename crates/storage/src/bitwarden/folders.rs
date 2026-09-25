//! Folders behind the Bitwarden-compatible server (ADR 0141). A folder's
//! `name` is an `EncString` the server cannot open.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::{Db, Row};

/// A personal folder. `name` is an `EncString`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenFolder {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

fn folder_from_row(row: &SqliteRow) -> anyhow::Result<BitwardenFolder> {
    Ok(BitwardenFolder {
        id: row.get("id"),
        user_id: row.get("user_id"),
        name: row.get("name"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

/// Insert a folder inside an import transaction.
pub(super) async fn insert_folder<'e, E>(
    executor: E,
    folder: &BitwardenFolder,
) -> anyhow::Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "INSERT INTO bitwarden_folders (id, user_id, name, created_at, revision_at) \
         VALUES (?,?,?,?,?)",
    )
    .bind(&folder.id)
    .bind(&folder.user_id)
    .bind(&folder.name)
    .bind(bitwarden_timestamp(folder.created_at))
    .bind(bitwarden_timestamp(folder.revision_at))
    .execute(executor)
    .await?;
    Ok(())
}

impl Db {
    /// Every folder the account owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_folders(&self, user_id: &str) -> anyhow::Result<Vec<BitwardenFolder>> {
        let rows = sqlx::query(
            "SELECT id, user_id, name, created_at, revision_at FROM bitwarden_folders \
             WHERE user_id = ? ORDER BY created_at, id",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(folder_from_row).collect()
    }

    /// One folder, only if the account owns it.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_folder(
        &self,
        user_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenFolder>> {
        let row = sqlx::query(
            "SELECT id, user_id, name, created_at, revision_at FROM bitwarden_folders \
             WHERE user_id = ? AND id = ?",
        )
        .bind(user_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(folder_from_row).transpose()
    }

    /// Create a folder, or rename one the same account owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_put_folder(&self, folder: &BitwardenFolder) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO bitwarden_folders (id, user_id, name, created_at, revision_at) \
             VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
             revision_at = excluded.revision_at WHERE bitwarden_folders.user_id = excluded.user_id",
        )
        .bind(&folder.id)
        .bind(&folder.user_id)
        .bind(&folder.name)
        .bind(bitwarden_timestamp(folder.created_at))
        .bind(bitwarden_timestamp(folder.revision_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete a folder; its ciphers fall back to "no folder", as Bitwarden does.
    /// Returns whether a folder was deleted.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn bitwarden_delete_folder(&self, user_id: &str, id: &str) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE bitwarden_ciphers SET folder_id = NULL WHERE user_id = ? AND folder_id = ?",
        )
        .bind(user_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let done = sqlx::query("DELETE FROM bitwarden_folders WHERE user_id = ? AND id = ?")
            .bind(user_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(done.rows_affected() == 1)
    }
}
