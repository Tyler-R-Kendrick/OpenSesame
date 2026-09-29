//! Collections behind the Bitwarden-compatible server (ADR 0148): named
//! groups of an organization's ciphers (the name an `EncString` under the
//! organization key), and which members reach each, how.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use crate::Db;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenCollection {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub external_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

/// How one member reaches one collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenCollectionAccess {
    pub collection_id: String,
    pub member_id: String,
    pub read_only: bool,
    pub hide_passwords: bool,
    pub manage: bool,
}

fn collection_from(row: &SqliteRow) -> anyhow::Result<BitwardenCollection> {
    Ok(BitwardenCollection {
        id: row.get("id"),
        org_id: row.get("org_id"),
        name: row.get("name"),
        external_id: row.get("external_id"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

fn access_from(row: &SqliteRow) -> BitwardenCollectionAccess {
    BitwardenCollectionAccess {
        collection_id: row.get("collection_id"),
        member_id: row.get("member_id"),
        read_only: row.get::<i64, _>("read_only") != 0,
        hide_passwords: row.get::<i64, _>("hide_passwords") != 0,
        manage: row.get::<i64, _>("manage") != 0,
    }
}

pub(super) async fn insert_collection(
    tx: &mut sqlx::SqliteConnection,
    collection: &BitwardenCollection,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO bitwarden_collections (id, org_id, name, external_id, created_at, revision_at) \
         VALUES (?,?,?,?,?,?)",
    )
    .bind(&collection.id)
    .bind(&collection.org_id)
    .bind(&collection.name)
    .bind(&collection.external_id)
    .bind(bitwarden_timestamp(collection.created_at))
    .bind(bitwarden_timestamp(collection.revision_at))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

pub(super) async fn write_access(
    tx: &mut sqlx::SqliteConnection,
    access: &[BitwardenCollectionAccess],
) -> anyhow::Result<()> {
    for grant in access {
        sqlx::query(
            "INSERT INTO bitwarden_collection_members (collection_id, member_id, read_only, \
             hide_passwords, manage) VALUES (?,?,?,?,?)",
        )
        .bind(&grant.collection_id)
        .bind(&grant.member_id)
        .bind(i64::from(grant.read_only))
        .bind(i64::from(grant.hide_passwords))
        .bind(i64::from(grant.manage))
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

impl Db {
    /// An organization's collections.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_collections(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<BitwardenCollection>> {
        let rows = sqlx::query(
            "SELECT id, org_id, name, external_id, created_at, revision_at \
             FROM bitwarden_collections WHERE org_id = ? ORDER BY created_at, id",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(collection_from).collect()
    }

    /// Who reaches the organization's collections, and how.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_collection_access(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<BitwardenCollectionAccess>> {
        let rows = sqlx::query(
            "SELECT cm.collection_id, cm.member_id, cm.read_only, cm.hide_passwords, cm.manage \
             FROM bitwarden_collection_members cm \
             JOIN bitwarden_collections c ON c.id = cm.collection_id WHERE c.org_id = ?",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(access_from).collect())
    }

    /// Which of the organization's ciphers sit in which collections.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn bitwarden_collection_ciphers(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        Ok(sqlx::query_as(
            "SELECT cc.collection_id, cc.cipher_id FROM bitwarden_collection_ciphers cc \
             JOIN bitwarden_collections c ON c.id = cc.collection_id WHERE c.org_id = ?",
        )
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Create a collection with the members who reach it.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_create_collection(
        &self,
        collection: &BitwardenCollection,
        access: &[BitwardenCollectionAccess],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        insert_collection(&mut tx, collection).await?;
        write_access(&mut tx, access).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Rename a collection; with `access`, replace who reaches it.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_update_collection(
        &self,
        collection: &BitwardenCollection,
        access: Option<&[BitwardenCollectionAccess]>,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE bitwarden_collections SET name = ?, external_id = ?, revision_at = ? \
             WHERE id = ? AND org_id = ?",
        )
        .bind(&collection.name)
        .bind(&collection.external_id)
        .bind(bitwarden_timestamp(collection.revision_at))
        .bind(&collection.id)
        .bind(&collection.org_id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() != 1 {
            return Ok(false);
        }
        if let Some(access) = access {
            sqlx::query("DELETE FROM bitwarden_collection_members WHERE collection_id = ?")
                .bind(&collection.id)
                .execute(&mut *tx)
                .await?;
            write_access(&mut tx, access).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Replace the collections one member reaches in an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_set_member_collections(
        &self,
        org_id: &str,
        member_id: &str,
        access: &[BitwardenCollectionAccess],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM bitwarden_collection_members WHERE member_id = ? AND collection_id IN \
             (SELECT id FROM bitwarden_collections WHERE org_id = ?)",
        )
        .bind(member_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
        write_access(&mut tx, access).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Delete collections; their ciphers stay in the organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_collections(
        &self,
        org_id: &str,
        ids: &[String],
    ) -> anyhow::Result<u64> {
        let mut deleted = 0;
        for id in ids {
            deleted += sqlx::query("DELETE FROM bitwarden_collections WHERE id = ? AND org_id = ?")
                .bind(id)
                .bind(org_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        }
        Ok(deleted)
    }
}
