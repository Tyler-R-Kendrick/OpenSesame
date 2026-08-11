use anyhow::Context;
use async_trait::async_trait;
use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionRecord, Grant, Intent, Invocation, InvocationReceipt, OrganizationId,
    ProjectId,
};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::Path;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSyncBlob {
    pub id: String,
    pub epoch: u64,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncWriteOutcome {
    Accepted,
    ForeignOwner,
    OwnerQuota,
    StoreFull,
    StaleEpoch,
}

impl Db {
    pub async fn connect_sqlite(url: &str) -> anyhow::Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(url)
            .await?;
        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    pub async fn connect_memory() -> anyhow::Result<Self> {
        Self::connect_sqlite("sqlite::memory:").await
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        let sql = include_str!("../../../migrations/0001_init.sql");
        for stmt in sql.split(';') {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            sqlx::query(stmt)
                .execute(&self.pool)
                .await
                .with_context(|| format!("migrating: {stmt}"))?;
        }
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn authority_quorum_ok(&self) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT quorum_ok, sealed FROM authority_health WHERE id = 1")
            .fetch_one(&self.pool)
            .await?;
        let quorum_ok: i64 = row.get("quorum_ok");
        let sealed: i64 = row.get("sealed");
        Ok(quorum_ok == 1 && sealed == 0)
    }

    pub async fn set_authority_quorum(&self, ok: bool) -> anyhow::Result<()> {
        sqlx::query("UPDATE authority_health SET quorum_ok = ?, updated_at = ? WHERE id = 1")
            .bind(if ok { 1 } else { 0 })
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn create_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(id.to_string())
            .bind(name)
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn create_project(
        &self,
        id: &ProjectId,
        org: &OrganizationId,
        name: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(org.to_string())
        .bind(name)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<()> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        sqlx::query(
            "INSERT INTO provider_connections (id, organization_id, project_id, provider_id, display_name, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .bind(connection.project_id.map(|id| id.to_string()))
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.created_at.to_rfc3339())
        .bind(connection.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<bool> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        let result = sqlx::query(
            "UPDATE provider_connections SET provider_id = ?, display_name = ?, body_json = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.updated_at.to_rfc3339())
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn get_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<Option<ConnectionRecord>> {
        let row = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE id = ? AND organization_id = ?",
        )
        .bind(id.to_string())
        .bind(organization_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| serde_json::from_str(&row.get::<String, _>("body_json")))
            .transpose()
            .map_err(Into::into)
    }

    pub async fn list_connections(
        &self,
        organization_id: &OrganizationId,
    ) -> anyhow::Result<Vec<ConnectionRecord>> {
        let rows = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE organization_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(&row.get::<String, _>("body_json")).map_err(Into::into))
            .collect()
    }

    pub async fn delete_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM provider_connections WHERE id = ? AND organization_id = ?")
                .bind(id.to_string())
                .bind(organization_id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn insert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(grant.id.to_string())
        .bind(grant.organization_id.to_string())
        .bind(serde_json::to_string(grant)?)
        .bind(grant.revoked_at.map(|t| t.to_rfc3339()))
        .bind(grant.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_intent(&self, intent: &Intent) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO intents (id, organization_id, body_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(intent.id.to_string())
        .bind(intent.organization_id.to_string())
        .bind(serde_json::to_string(intent)?)
        .bind(&intent.idempotency_key)
        .bind(intent.issued_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_invocation(&self, inv: &Invocation) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO invocations (id, intent_id, state, attempt, lease_owner, lease_expires_at, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(inv.id.to_string())
        .bind(inv.intent_id.to_string())
        .bind(format!("{:?}", inv.state).to_lowercase())
        .bind(inv.attempt as i64)
        .bind(&inv.lease_owner)
        .bind(inv.lease_expires_at.map(|t| t.to_rfc3339()))
        .bind(serde_json::to_string(inv)?)
        .bind(inv.created_at.to_rfc3339())
        .bind(inv.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_receipt(&self, receipt: &InvocationReceipt) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO receipts (id, invocation_id, body_json, signature, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(receipt.id.to_string())
        .bind(receipt.invocation_id.to_string())
        .bind(serde_json::to_string(receipt)?)
        .bind(&receipt.signature)
        .bind(receipt.completed_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_receipt(
        &self,
        id: &opensesame_domain::ReceiptId,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let keyed = id.to_string();
        let bare = id.as_uuid().to_string();
        let row = sqlx::query("SELECT id, body_json FROM receipts WHERE id = ? OR id = ?")
            .bind(&keyed)
            .bind(&bare)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                Some(serde_json::from_str(&body)?)
            }
            None => None,
        })
    }

    pub async fn count_invocations_for_intent(
        &self,
        intent_id: &opensesame_domain::IntentId,
    ) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) as c FROM invocations WHERE intent_id = ?")
            .bind(intent_id.to_string())
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("c"))
    }

    pub async fn count_receipts(&self) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) as c FROM receipts")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("c"))
    }

    pub async fn find_receipt_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let row = sqlx::query(
            r#"
            SELECT r.body_json
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE i.organization_id = ? AND i.idempotency_key = ?
            ORDER BY r.created_at ASC
            LIMIT 1
            "#,
        )
        .bind(org.to_string())
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                Some(serde_json::from_str(&body)?)
            }
            None => None,
        })
    }

    pub async fn find_intent_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<Intent>> {
        let row = sqlx::query(
            "SELECT body_json FROM intents WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(org.to_string())
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                Some(serde_json::from_str(&body)?)
            }
            None => None,
        })
    }

    pub async fn insert_encrypted_item(
        &self,
        vault_id: &str,
        item_id: &str,
        revision: i64,
        ciphertext: &[u8],
        wrapping_json: &str,
        ad_digest: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO encrypted_item_revisions (id, vault_id, item_id, revision, envelope_version, ciphertext, wrapping_json, ad_digest, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(vault_id)
        .bind(item_id)
        .bind(revision)
        .bind(ciphertext)
        .bind(wrapping_json)
        .bind(ad_digest)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn write_sync_blob(
        &self,
        owner_id: &str,
        blob: &StoredSyncBlob,
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<SyncWriteOutcome> {
        let epoch = i64::try_from(blob.epoch).context("sync epoch exceeds SQLite range")?;
        let mut transaction = self.pool.begin().await?;
        let existing = sqlx::query("SELECT owner_id, epoch FROM encrypted_sync_blobs WHERE id = ?")
            .bind(&blob.id)
            .fetch_optional(&mut *transaction)
            .await?;
        if let Some(row) = existing {
            let existing_owner: String = row.get("owner_id");
            if existing_owner != owner_id {
                return Ok(SyncWriteOutcome::ForeignOwner);
            }
            let existing_epoch: i64 = row.get("epoch");
            if existing_epoch > epoch {
                return Ok(SyncWriteOutcome::StaleEpoch);
            }
            sqlx::query(
                "UPDATE encrypted_sync_blobs SET epoch = ?, ciphertext = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
            )
            .bind(epoch)
            .bind(&blob.ciphertext)
            .bind(Utc::now().to_rfc3339())
            .bind(&blob.id)
            .bind(owner_id)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            return Ok(SyncWriteOutcome::Accepted);
        }
        let store_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
            .fetch_one(&mut *transaction)
            .await?
            .get("count");
        if store_count >= store_limit {
            return Ok(SyncWriteOutcome::StoreFull);
        }
        let owner_count: i64 =
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs WHERE owner_id = ?")
                .bind(owner_id)
                .fetch_one(&mut *transaction)
                .await?
                .get("count");
        if owner_count >= owner_limit {
            return Ok(SyncWriteOutcome::OwnerQuota);
        }
        sqlx::query(
            "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&blob.id)
        .bind(owner_id)
        .bind(epoch)
        .bind(&blob.ciphertext)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(SyncWriteOutcome::Accepted)
    }

    pub async fn list_sync_blobs(
        &self,
        owner_id: &str,
        since_epoch: u64,
    ) -> anyhow::Result<Vec<StoredSyncBlob>> {
        let since_epoch = match i64::try_from(since_epoch) {
            Ok(epoch) => epoch,
            Err(_) => return Ok(vec![]),
        };
        let rows = sqlx::query(
            "SELECT id, epoch, ciphertext FROM encrypted_sync_blobs WHERE owner_id = ? AND epoch > ? ORDER BY epoch, id",
        )
        .bind(owner_id)
        .bind(since_epoch)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| StoredSyncBlob {
                id: row.get("id"),
                epoch: row.get::<i64, _>("epoch") as u64,
                ciphertext: row.get("ciphertext"),
            })
            .collect())
    }

    pub async fn count_sync_blobs(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    pub async fn advance_sync_cursor(
        &self,
        owner_id: &str,
        device_id: &str,
        epoch: u64,
        max_cursors: i64,
    ) -> anyhow::Result<Option<u64>> {
        let epoch = i64::try_from(epoch).context("sync cursor exceeds SQLite range")?;
        let mut transaction = self.pool.begin().await?;
        let existing = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if existing.is_none() {
            let count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM sync_device_cursors")
                .fetch_one(&mut *transaction)
                .await?
                .get("count");
            if count >= max_cursors {
                return Ok(None);
            }
        }
        sqlx::query(
            "INSERT INTO sync_device_cursors (owner_id, device_id, epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, device_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch), updated_at = excluded.updated_at",
        )
        .bind(owner_id)
        .bind(device_id)
        .bind(epoch)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        let cursor = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_one(&mut *transaction)
        .await?
        .get::<i64, _>("epoch") as u64;
        transaction.commit().await?;
        Ok(Some(cursor))
    }
}

#[async_trait]
pub trait Store: Send + Sync {
    async fn quorum_ok(&self) -> anyhow::Result<bool>;
}

#[async_trait]
impl Store for Db {
    async fn quorum_ok(&self) -> anyhow::Result<bool> {
        self.authority_quorum_ok().await
    }
}

pub fn sqlite_file_url(path: &Path) -> String {
    format!("sqlite://{}?mode=rwc", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_domain::OrganizationId;

    #[tokio::test]
    async fn migrate_and_org_boundary() {
        let db = Db::connect_memory().await.unwrap();
        let org = OrganizationId::new();
        db.create_organization(&org, "acme").await.unwrap();
        assert!(db.authority_quorum_ok().await.unwrap());
        db.set_authority_quorum(false).await.unwrap();
        assert!(!db.authority_quorum_ok().await.unwrap());
    }

    #[tokio::test]
    async fn connection_crud_is_org_scoped_and_rejects_inline_secrets() {
        let db = Db::connect_memory().await.unwrap();
        let org = OrganizationId::new();
        db.create_organization(&org, "acme").await.unwrap();
        let now = Utc::now();
        let mut connection = ConnectionRecord {
            id: ConnectionId::new(),
            organization_id: org,
            project_id: None,
            provider_id: "aws-secrets-manager".into(),
            display_name: "production".into(),
            public_config: serde_json::json!({"region": "us-east-1"}),
            credential_ref: None,
            created_at: now,
            updated_at: now,
        };
        db.insert_connection(&connection).await.unwrap();
        assert_eq!(
            db.list_connections(&org).await.unwrap(),
            vec![connection.clone()]
        );
        connection.public_config = serde_json::json!({"api_token": "plaintext"});
        assert!(db.update_connection(&connection).await.is_err());
        assert!(db.delete_connection(&org, &connection.id).await.unwrap());
    }

    #[tokio::test]
    async fn encrypted_sync_survives_new_db_handles_and_is_owner_scoped() {
        let db = Db::connect_memory().await.unwrap();
        let blob = StoredSyncBlob {
            id: "vault-1".into(),
            epoch: 7,
            ciphertext: vec![1, 2, 3],
        };
        assert_eq!(
            db.write_sync_blob("principal:alice", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::Accepted
        );
        assert_eq!(
            db.write_sync_blob("principal:bob", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::ForeignOwner
        );
        assert_eq!(
            db.list_sync_blobs("principal:alice", 0).await.unwrap(),
            vec![blob]
        );
        assert!(db
            .list_sync_blobs("principal:bob", 0)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "device", 7, 1)
                .await
                .unwrap(),
            Some(7)
        );
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "another-device", 7, 1)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "device", 9, 1)
                .await
                .unwrap(),
            Some(9)
        );
    }
}
