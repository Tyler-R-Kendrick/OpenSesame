use anyhow::Context;
use async_trait::async_trait;
use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionRecord, Grant, GrantId, Intent, Invocation, InvocationReceipt,
    OrganizationId, ProjectId,
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

/// Receipt evidence plus the authoritative organization resolved through its
/// invocation and intent. Legacy signed bodies may omit the organization; the
/// join supplies authorization context without changing the signed bytes.
pub struct StoredReceipt {
    pub receipt: InvocationReceipt,
    pub organization_id: OrganizationId,
}

fn decode_receipt_for_organization(
    body: &str,
    organization_id: &str,
) -> anyhow::Result<StoredReceipt> {
    let receipt: InvocationReceipt = serde_json::from_str(body)?;
    let organization_id = OrganizationId::parse(organization_id)?;
    if receipt
        .organization_id
        .is_some_and(|claimed| claimed != organization_id)
    {
        anyhow::bail!("receipt organization does not match invocation intent");
    }
    Ok(StoredReceipt {
        receipt,
        organization_id,
    })
}

/// Embedded schema versions, applied in order, once each. Appending is the only
/// permitted edit: an applied version is never rewritten.
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_init",
        include_str!("../../../migrations/0001_init.sql"),
    ),
    (
        "0002_connections",
        include_str!("../../../migrations/0002_connections.sql"),
    ),
    (
        "0003_connection_owner",
        include_str!("../../../migrations/0003_connection_owner.sql"),
    ),
    (
        "0004_integrations",
        include_str!("../../../migrations/0004_integrations.sql"),
    ),
    (
        "0005_credential_generation",
        include_str!("../../../migrations/0005_credential_generation.sql"),
    ),
    (
        "0006_provider_configuration",
        include_str!("../../../migrations/0006_provider_configuration.sql"),
    ),
    (
        "0007_provider_connections",
        include_str!("../../../migrations/0007_provider_connections.sql"),
    ),
    (
        "0008_backup_outbox",
        include_str!("../../../migrations/0008_backup_outbox.sql"),
    ),
    (
        "0009_host_kv",
        include_str!("../../../migrations/0009_host_kv.sql"),
    ),
    (
        "0010_connection_materialization",
        include_str!("../../../migrations/0010_connection_materialization.sql"),
    ),
    (
        "0011_attachment_targets",
        include_str!("../../../migrations/0011_attachment_targets.sql"),
    ),
    (
        "0012_connection_delegations",
        include_str!("../../../migrations/0012_connection_delegations.sql"),
    ),
];

impl Db {
    pub async fn connect_sqlite(url: &str) -> anyhow::Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(if url == "sqlite::memory:" { 1 } else { 5 })
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
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await
        .context("creating schema_migrations")?;

        for (version, sql) in MIGRATIONS {
            if self.migration_applied(version).await? {
                continue;
            }
            // A version lands whole or not at all, so a failure mid-file cannot
            // leave a database that reports itself migrated.
            let mut tx = self.pool.begin().await?;
            for stmt in split_statements(sql) {
                sqlx::query(&stmt)
                    .execute(&mut *tx)
                    .await
                    .with_context(|| format!("migration {version}: {stmt}"))?;
            }
            sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                .bind(version)
                .bind(Utc::now().to_rfc3339())
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            tracing::info!(migration = version, "schema migration applied");
        }
        Ok(())
    }

    pub async fn applied_migrations(&self) -> anyhow::Result<Vec<String>> {
        let rows = sqlx::query("SELECT version FROM schema_migrations ORDER BY version ASC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| r.get::<String, _>("version"))
            .collect())
    }

    async fn migration_applied(&self, version: &str) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
            .bind(version)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
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
        let mut transaction = self.pool.begin().await?;
        // Organization membership is established by Identity before Host mints
        // the session. Materialize that trusted tenant locally so the provider
        // connection can satisfy Host's foreign-key boundary.
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(connection.organization_id.to_string())
            .bind(connection.organization_id.to_string())
            .bind(Utc::now().to_rfc3339())
            .execute(&mut *transaction)
            .await?;
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
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
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

    pub async fn find_grant(&self, id: &GrantId) -> anyhow::Result<Option<Grant>> {
        let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let mut grant: Grant = serde_json::from_str(&row.get::<String, _>("body_json"))?;
        // The column is the authority on revocation: `revoke_grant` writes it
        // without rewriting body_json, so a stale body must not resurrect a
        // revoked grant.
        if let Some(revoked) = row.get::<Option<String>, _>("revoked_at") {
            grant.revoked_at = grant.revoked_at.or_else(|| {
                chrono::DateTime::parse_from_rfc3339(&revoked)
                    .ok()
                    .map(|t| t.with_timezone(&chrono::Utc))
            });
        }
        Ok(Some(grant))
    }

    pub async fn revoke_grant(
        &self,
        id: &GrantId,
        at: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                .bind(at.to_rfc3339())
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Assert every hop of a delegation chain is live, walking `parent_grant_id`
    /// up from `grant` to the root. Ancestor revocation must kill descendants:
    /// a child that stayed "active" after its parent died would be authority
    /// that outlived the thing it narrowed (ADR 0044 decision 8).
    pub async fn assert_grant_chain_active(
        &self,
        grant: &Grant,
        now: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<()> {
        grant.assert_active(now)?;
        let mut cursor = grant.parent_grant_id;
        // Bounded walk: depth is validated at mint, but a storage cycle must
        // fail closed rather than spin.
        for _ in 0..16 {
            let Some(parent_id) = cursor else {
                return Ok(());
            };
            let parent = self
                .find_grant(&parent_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("delegation chain hop missing: {parent_id}"))?;
            parent.assert_active(now)?;
            cursor = parent.parent_grant_id;
        }
        anyhow::bail!("delegation chain too deep to verify")
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
    ) -> anyhow::Result<Option<StoredReceipt>> {
        let keyed = id.to_string();
        let bare = id.as_uuid().to_string();
        let row = sqlx::query(
            r#"
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE r.id = ? OR r.id = ?
            "#,
        )
        .bind(&keyed)
        .bind(&bare)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                let organization_id: String = r.get("authoritative_organization_id");
                Some(decode_receipt_for_organization(&body, &organization_id)?)
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
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
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
                let organization_id: String = r.get("authoritative_organization_id");
                Some(decode_receipt_for_organization(&body, &organization_id)?.receipt)
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
        let mut transaction = self.pool.begin().await?;
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
        .execute(&mut *transaction)
        .await?;
        append_outbox_tx(
            &mut transaction,
            "vault.item_revision.written",
            &serde_json::json!({
                "vault_id": vault_id,
                "item_id": item_id,
                "revision": revision,
            })
            .to_string(),
        )
        .await?;
        transaction.commit().await?;
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
            append_sync_blob_outbox(&mut transaction, owner_id, &blob.id, epoch).await?;
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
        append_sync_blob_outbox(&mut transaction, owner_id, &blob.id, epoch).await?;
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

    // —— transactional outbox (ADR 0039) ————————————————————————

    /// Broadcast a change event in its own transaction. Mutations that already
    /// hold a transaction use [`append_outbox_tx`] instead, so the event and
    /// the change it describes commit or roll back together.
    pub async fn append_outbox(
        &self,
        event_type: &str,
        payload_json: &str,
    ) -> anyhow::Result<String> {
        let mut transaction = self.pool.begin().await?;
        let id = append_outbox_tx(&mut transaction, event_type, payload_json).await?;
        transaction.commit().await?;
        Ok(id)
    }

    /// Claim due unpublished events for one worker pass. Claimed rows have
    /// their `available_at` pushed `lease_seconds` into the future, so a
    /// crashed worker's claim expires instead of wedging the queue.
    pub async fn claim_outbox_batch(
        &self,
        limit: i64,
        lease_seconds: i64,
    ) -> anyhow::Result<Vec<OutboxEvent>> {
        let now = Utc::now();
        let mut transaction = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT id, event_type, payload_json, created_at, attempts FROM outbox_events \
             WHERE published_at IS NULL AND (available_at IS NULL OR available_at <= ?) \
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(limit)
        .fetch_all(&mut *transaction)
        .await?;
        let events: Vec<OutboxEvent> = rows
            .into_iter()
            .map(|row| OutboxEvent {
                id: row.get("id"),
                event_type: row.get("event_type"),
                payload_json: row.get("payload_json"),
                created_at: row.get("created_at"),
                attempts: row.get("attempts"),
            })
            .collect();
        if !events.is_empty() {
            let lease = (now + chrono::Duration::seconds(lease_seconds)).to_rfc3339();
            for event in &events {
                sqlx::query("UPDATE outbox_events SET available_at = ? WHERE id = ?")
                    .bind(&lease)
                    .bind(&event.id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        transaction.commit().await?;
        Ok(events)
    }

    pub async fn mark_outbox_published(&self, ids: &[String]) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = NULL WHERE id = ?",
            )
            .bind(&now)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Compensation for a failed delivery: release the claim, count the
    /// attempt, and back the event off so retries do not spin.
    pub async fn park_outbox(
        &self,
        ids: &[String],
        error: &str,
        backoff_seconds: i64,
    ) -> anyhow::Result<()> {
        let available = (Utc::now() + chrono::Duration::seconds(backoff_seconds)).to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET available_at = ?, attempts = attempts + 1, last_error = ? \
                 WHERE id = ? AND published_at IS NULL",
            )
            .bind(&available)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Terminal compensation for a poison event: record the failure and stop
    /// retrying. Full-snapshot resync reconciles whatever the event described.
    pub async fn dead_letter_outbox(&self, ids: &[String], error: &str) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = ? WHERE id = ? AND published_at IS NULL",
            )
            .bind(&now)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn count_unpublished_outbox(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM outbox_events WHERE published_at IS NULL")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    // —— host operator kv ————————————————————————————————

    pub async fn get_host_kv(&self, key: &str) -> anyhow::Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM host_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    pub async fn set_host_kv(&self, key: &str, value: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert `key` only when absent. Returns `true` when this call claimed the key.
    pub async fn try_claim_host_kv(&self, key: &str, value: &str) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_host_kv(&self, key: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM host_kv WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // —— backup targets (ADR 0039) ——————————————————————————————

    pub async fn upsert_backup_target(&self, target: &BackupTarget) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO backup_targets (organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               integration_id = excluded.integration_id, \
               installation_id = excluded.installation_id, \
               owner = excluded.owner, \
               repo = excluded.repo, \
               branch = excluded.branch, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               last_error = NULL, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.integration_id)
        .bind(&target.installation_id)
        .bind(&target.owner)
        .bind(&target.repo)
        .bind(&target.branch)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_backup_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<BackupTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, last_commit_sha, last_synced_at, last_error \
             FROM backup_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| BackupTarget {
            organization_id: row.get("organization_id"),
            integration_id: row.get("integration_id"),
            installation_id: row.get("installation_id"),
            owner: row.get("owner"),
            repo: row.get("repo"),
            branch: row.get("branch"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_commit_sha: row.get("last_commit_sha"),
            last_synced_at: row.get("last_synced_at"),
            last_error: row.get("last_error"),
        }))
    }

    /// Record the outcome of a backup pass without touching the configuration.
    pub async fn record_backup_outcome(
        &self,
        organization_id: &str,
        status: &str,
        last_commit_sha: Option<&str>,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE backup_targets SET status = ?, \
               last_commit_sha = COALESCE(?, last_commit_sha), \
               last_synced_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_synced_at END, \
               last_error = ?, updated_at = ? WHERE organization_id = ?",
        )
        .bind(status)
        .bind(last_commit_sha)
        .bind(last_commit_sha)
        .bind(Utc::now().to_rfc3339())
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_attachment_target(
        &self,
        target: &AttachmentTarget,
    ) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO attachment_targets (organization_id, connection_id, provider_id, folder_path, enabled, status, updated_at_unix_ms, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               connection_id = excluded.connection_id, \
               provider_id = excluded.provider_id, \
               folder_path = excluded.folder_path, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               last_error = NULL, \
               updated_at_unix_ms = excluded.updated_at_unix_ms, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.connection_id)
        .bind(&target.provider_id)
        .bind(&target.folder_path)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(target.updated_at_unix_ms)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_attachment_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<AttachmentTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, connection_id, provider_id, folder_path, enabled, status, last_error, updated_at_unix_ms \
             FROM attachment_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AttachmentTarget {
            organization_id: row.get("organization_id"),
            connection_id: row.get("connection_id"),
            provider_id: row.get("provider_id"),
            folder_path: row.get("folder_path"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_error: row.get("last_error"),
            updated_at_unix_ms: row.get("updated_at_unix_ms"),
        }))
    }

    /// Record a replication failure without disturbing the configuration.
    pub async fn record_attachment_target_error(
        &self,
        organization_id: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE attachment_targets SET status = ?, last_error = ?, updated_at = ? \
             WHERE organization_id = ?",
        )
        .bind(if last_error.is_some() { "error" } else { "ok" })
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_attachment_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM attachment_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_backup_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM backup_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Ciphertext rows a snapshot is built from. Only sealed bytes leave this
    /// query; there is no plaintext anywhere in the backup path.
    pub async fn list_encrypted_item_revisions(
        &self,
    ) -> anyhow::Result<Vec<EncryptedItemRevision>> {
        let rows = sqlx::query(
            "SELECT vault_id, item_id, revision, ciphertext, wrapping_json, ad_digest FROM encrypted_item_revisions ORDER BY vault_id, item_id, revision",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| EncryptedItemRevision {
                vault_id: row.get("vault_id"),
                item_id: row.get("item_id"),
                revision: row.get("revision"),
                ciphertext: row.get("ciphertext"),
                wrapping_json: row.get("wrapping_json"),
                ad_digest: row.get("ad_digest"),
            })
            .collect())
    }

    pub async fn list_all_sync_blobs(&self) -> anyhow::Result<Vec<(String, StoredSyncBlob)>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, epoch, ciphertext FROM encrypted_sync_blobs ORDER BY owner_id, epoch, id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get("owner_id"),
                    StoredSyncBlob {
                        id: row.get("id"),
                        epoch: row.get::<i64, _>("epoch") as u64,
                        ciphertext: row.get("ciphertext"),
                    },
                )
            })
            .collect())
    }
}

#[derive(Clone, Debug)]
pub struct OutboxEvent {
    pub id: String,
    pub event_type: String,
    pub payload_json: String,
    pub created_at: String,
    pub attempts: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupTarget {
    pub organization_id: String,
    pub integration_id: String,
    pub installation_id: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub enabled: bool,
    pub status: String,
    pub last_commit_sha: Option<String>,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
}

/// Where an organization's sealed attachment ciphertext is replicated
/// (ADR 0054). Configuration and status only: the gateway never holds chunks,
/// so there is nothing here to leak but a folder name.
#[derive(Clone, Debug)]
pub struct AttachmentTarget {
    pub organization_id: String,
    pub connection_id: String,
    pub provider_id: String,
    pub folder_path: String,
    pub enabled: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug)]
pub struct EncryptedItemRevision {
    pub vault_id: String,
    pub item_id: String,
    pub revision: i64,
    pub ciphertext: Vec<u8>,
    pub wrapping_json: String,
    pub ad_digest: String,
}

/// Append a change event inside an open transaction — the transactional-outbox
/// write that makes "every secret mutation broadcasts an event" crash-safe.
/// Shared with `connection-broker`, which writes the same pool.
pub async fn append_outbox_tx(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_type: &str,
    payload_json: &str,
) -> anyhow::Result<String> {
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO outbox_events (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(event_type)
    .bind(payload_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(id)
}

async fn append_sync_blob_outbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner_id: &str,
    blob_id: &str,
    epoch: i64,
) -> anyhow::Result<()> {
    append_outbox_tx(
        transaction,
        "sync.blob.written",
        &serde_json::json!({"owner_id": owner_id, "blob_id": blob_id, "epoch": epoch}).to_string(),
    )
    .await?;
    Ok(())
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

/// Embedded migrations are hand-written and contain no semicolon inside a string
/// literal. Trigger bodies are kept intact through their final `END;`.
fn split_statements(sql: &str) -> Vec<String> {
    let stripped: String = sql
        .lines()
        .map(|line| match line.find("--") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut statements = Vec::new();
    let mut current = String::new();
    for ch in stripped.chars() {
        if ch != ';' {
            current.push(ch);
            continue;
        }
        let trimmed = current.trim();
        let trigger_body = trimmed.starts_with("CREATE TRIGGER") && !trimmed.ends_with("END");
        if trigger_body {
            current.push(';');
            continue;
        }
        if !trimmed.is_empty() {
            statements.push(trimmed.to_string());
        }
        current.clear();
    }
    if !current.trim().is_empty() {
        statements.push(current.trim().to_string());
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_domain::*;
    use serde_json::json;

    fn evidence(
        organization_id: OrganizationId,
        claimed_organization_id: Option<OrganizationId>,
        idempotency_key: &str,
    ) -> (Intent, Invocation, InvocationReceipt) {
        let now = Utc::now();
        let intent = Intent {
            id: IntentId::new(),
            organization_id,
            project_id: None,
            principal_id: PrincipalId::new(),
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            connection_id: None,
            operation: "read".into(),
            resource: "doc:1".into(),
            audience: "https://resource.example".into(),
            normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
            body_hash: None,
            nonce: uuid::Uuid::new_v4().to_string(),
            idempotency_key: idempotency_key.into(),
            issued_at: now,
            expires_at: now + Duration::minutes(5),
            parent_invocation_id: None,
            delegation_chain: vec![],
            proof: DetachedProof {
                algorithm: "test".into(),
                key_thumbprint: "test".into(),
                signature: "test".into(),
            },
        };
        let invocation = Invocation {
            id: InvocationId::new(),
            intent_id: intent.id,
            state: InvocationState::Succeeded,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: invocation.id,
            intent_digest: "sha256:intent".into(),
            principal_id: intent.principal_id,
            organization_id: claimed_organization_id,
            actor_id: intent.actor_id,
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            policy_decision_id: "decision".into(),
            policy_version_digest: "sha256:policy".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: now,
            completed_at: now,
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(json!({"ok": true})),
            authority_key_id: "test".into(),
            signature: "test".into(),
            receipt_schema_version: if claimed_organization_id.is_some() {
                3
            } else {
                1
            },
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        (intent, invocation, receipt)
    }

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
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM organizations WHERE id = ?")
                .bind(org.to_string())
                .fetch_one(db.pool())
                .await
                .unwrap(),
            1
        );
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

    #[tokio::test]
    async fn receipt_reads_resolve_legacy_org_and_reject_claim_mismatch() {
        let db = Db::connect_memory().await.unwrap();
        let organization_id = OrganizationId::new();
        db.create_organization(&organization_id, "acme")
            .await
            .unwrap();

        let (intent, invocation, legacy) = evidence(organization_id, None, "legacy");
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&invocation).await.unwrap();
        db.insert_receipt(&legacy).await.unwrap();
        let stored = db.get_receipt(&legacy.id).await.unwrap().unwrap();
        assert_eq!(stored.organization_id, organization_id);
        assert_eq!(stored.receipt.organization_id, None);
        assert_eq!(
            db.find_receipt_by_idempotency(&organization_id, "legacy")
                .await
                .unwrap()
                .unwrap()
                .organization_id,
            None
        );

        let (intent, invocation, mismatched) =
            evidence(organization_id, Some(OrganizationId::new()), "mismatch");
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&invocation).await.unwrap();
        db.insert_receipt(&mismatched).await.unwrap();
        assert!(db.get_receipt(&mismatched.id).await.is_err());
        assert!(db
            .find_receipt_by_idempotency(&organization_id, "mismatch")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn in_memory_database_keeps_one_migrated_schema() {
        let db = Db::connect_memory().await.unwrap();
        assert_eq!(db.pool().options().get_max_connections(), 1);
        sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(db.pool())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn every_migration_is_recorded_once() {
        let db = Db::connect_memory().await.unwrap();
        let applied = db.applied_migrations().await.unwrap();
        assert_eq!(
            applied,
            MIGRATIONS
                .iter()
                .map(|(v, _)| v.to_string())
                .collect::<Vec<_>>()
        );

        // A second boot must be a no-op rather than replaying schema changes.
        db.migrate().await.unwrap();
        assert_eq!(db.applied_migrations().await.unwrap(), applied);
    }

    #[tokio::test]
    async fn migrating_an_existing_database_records_without_destroying() {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, shareability, max_invoke_level, egress_json, created_at, updated_at) \
             VALUES ('c1','org:1',NULL,'github','github/main','GitHub','pending',NULL,'[]','[]',NULL,'organization','private',2,'{}','t','t')",
        )
        .execute(db.pool())
        .await
        .unwrap();

        db.migrate().await.unwrap();

        let row = sqlx::query("SELECT COUNT(*) AS c FROM connections")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("c"), 1);
    }

    #[tokio::test]
    async fn legacy_connection_rows_survive_the_broker_migration() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in split_statements(include_str!("../../../migrations/0001_init.sql")) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO organizations (id, name, created_at) VALUES ('org:1', 'Legacy', 't')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, connector_id, connector_version, component_digest, display_name, policy_json, created_at) VALUES ('legacy-1', 'org:1', NULL, 'github', '1', 'sha256:x', 'Legacy', '{}', 't')")
            .execute(&pool)
            .await
            .unwrap();

        let db = Db { pool };
        db.migrate().await.unwrap();
        let legacy = sqlx::query("SELECT id FROM legacy_connections WHERE id = 'legacy-1'")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(legacy.get::<String, _>("id"), "legacy-1");
        let broker_rows = sqlx::query("SELECT COUNT(*) AS n FROM connections")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(broker_rows.get::<i64, _>("n"), 0);
    }

    #[tokio::test]
    async fn credential_generation_migration_backfills_baseline_rows() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for (_, migration) in &MIGRATIONS[..4] {
            for statement in split_statements(migration) {
                sqlx::query(&statement).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'deployment:stripe')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connection_credentials (connection_id, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', X'01', X'02', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
            .execute(&pool)
            .await
            .unwrap();
        for statement in split_statements(include_str!(
            "../../../migrations/0005_credential_generation.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        let version = sqlx::query("SELECT version FROM connection_credentials")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<String, _>("version");
        assert!(!version.is_empty());
    }

    #[tokio::test]
    async fn provider_configuration_migration_indexes_legacy_fields_without_rewriting_secrets() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for (_, migration) in &MIGRATIONS[..5] {
            for statement in split_statements(migration) {
                sqlx::query(&statement).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO integrations (id, organization_id, key, provider_id, display_name, enabled, scopes, client_id, client_secret_ciphertext, client_secret_nonce, client_secret_aad_digest, created_by, created_at, updated_at) VALUES ('integration:legacy', 'org:legacy', 'legacy', 'github', 'Legacy', 1, '[]', 'client', X'01', X'02', 'aad', 'principal:admin', 't', 't')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'integration:legacy')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connection_credentials (connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', 'v1', X'03', X'04', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
            .execute(&pool)
            .await
            .unwrap();

        for statement in split_statements(include_str!(
            "../../../migrations/0006_provider_configuration.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }

        let integration_fields = sqlx::query(
            "SELECT configured_fields FROM integrations WHERE id = 'integration:legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<String, _>("configured_fields");
        let connection_fields = sqlx::query(
            "SELECT configured_fields FROM connection_credentials WHERE connection_id = 'connection:legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<String, _>("configured_fields");
        assert_eq!(integration_fields, r#"["client_id","client_secret"]"#);
        assert_eq!(connection_fields, r#"["api_key"]"#);
    }

    #[tokio::test]
    async fn provider_connections_are_added_to_an_already_migrated_database() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for (_, migration) in &MIGRATIONS[..6] {
            for statement in split_statements(migration) {
                sqlx::query(&statement).execute(&pool).await.unwrap();
            }
        }
        assert!(sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(&pool)
            .await
            .is_err());
        for statement in split_statements(include_str!(
            "../../../migrations/0007_provider_connections.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
    }

    #[test]
    fn statements_split_cleanly() {
        for (version, sql) in MIGRATIONS {
            let stmts = split_statements(sql);
            assert!(!stmts.is_empty(), "{version} produced no statements");
            assert!(
                stmts.iter().all(|s| !s.contains("--")),
                "{version} left a line comment inside a statement"
            );
        }
    }

    #[tokio::test]
    async fn outbox_claim_publish_park_dead_letter_lifecycle() {
        let db = Db::connect_memory().await.unwrap();
        let first = db
            .append_outbox("sync.blob.written", r#"{"blob_id":"b1"}"#)
            .await
            .unwrap();
        let second = db
            .append_outbox("connection.credential.stored", r#"{"connection_id":"c1"}"#)
            .await
            .unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 2);

        // Claiming leases the rows: a second immediate claim sees nothing.
        let claimed = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(claimed.len(), 2);
        assert_eq!(claimed[0].id, first);
        assert!(db.claim_outbox_batch(10, 60).await.unwrap().is_empty());

        // Success path.
        db.mark_outbox_published(&[first.clone()]).await.unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 1);

        // Compensation path: park releases the claim after the backoff.
        db.park_outbox(&[second.clone()], "github 502", 0)
            .await
            .unwrap();
        let retried = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(retried.len(), 1);
        assert_eq!(retried[0].id, second);
        assert_eq!(retried[0].attempts, 1);

        // Terminal compensation: dead-letter records the error and stops retries.
        db.dead_letter_outbox(&[second.clone()], "poison payload")
            .await
            .unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn sync_blob_writes_broadcast_an_outbox_event_atomically() {
        let db = Db::connect_memory().await.unwrap();
        let blob = StoredSyncBlob {
            id: "blob-1".into(),
            epoch: 1,
            ciphertext: vec![1, 2, 3],
        };
        assert_eq!(
            db.write_sync_blob("owner-1", &blob, 10, 10).await.unwrap(),
            SyncWriteOutcome::Accepted
        );
        let events = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "sync.blob.written");
        assert!(events[0].payload_json.contains("blob-1"));
    }

    #[tokio::test]
    async fn backup_target_round_trip_and_outcome_recording() {
        let db = Db::connect_memory().await.unwrap();
        let organization = OrganizationId::new();
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)")
            .bind(organization.to_string())
            .bind(Utc::now().to_rfc3339())
            .execute(db.pool())
            .await
            .unwrap();
        let target = BackupTarget {
            organization_id: organization.to_string(),
            integration_id: "github-app-1".into(),
            installation_id: "12345678".into(),
            owner: "acme".into(),
            repo: "opensesame-passwords".into(),
            branch: "main".into(),
            enabled: true,
            status: "pending".into(),
            last_commit_sha: None,
            last_synced_at: None,
            last_error: None,
        };
        db.upsert_backup_target(&target).await.unwrap();
        let loaded = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.repo, "opensesame-passwords");
        assert!(loaded.enabled);

        db.record_backup_outcome(&organization.to_string(), "ok", Some("abc123"), None)
            .await
            .unwrap();
        let synced = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(synced.status, "ok");
        assert_eq!(synced.last_commit_sha.as_deref(), Some("abc123"));
        assert!(synced.last_synced_at.is_some());

        // A failed pass keeps the last good commit but records the error.
        db.record_backup_outcome(&organization.to_string(), "suspended", None, Some("401"))
            .await
            .unwrap();
        let suspended = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(suspended.status, "suspended");
        assert_eq!(suspended.last_commit_sha.as_deref(), Some("abc123"));
        assert_eq!(suspended.last_error.as_deref(), Some("401"));
    }

    #[tokio::test]
    async fn host_kv_round_trip_and_overwrite() {
        let db = Db::connect_memory().await.unwrap();
        assert!(db.get_host_kv("taskbus.backend").await.unwrap().is_none());
        db.set_host_kv("taskbus.backend", "memory").await.unwrap();
        db.set_host_kv("taskbus.nats_url", "nats://127.0.0.1:4222")
            .await
            .unwrap();
        assert_eq!(
            db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
            Some("memory")
        );
        db.set_host_kv("taskbus.backend", "nats").await.unwrap();
        assert_eq!(
            db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
            Some("nats")
        );
        db.delete_host_kv("taskbus.nats_url").await.unwrap();
        assert!(db.get_host_kv("taskbus.nats_url").await.unwrap().is_none());
        db.set_host_kv("github.delivery.abc", "outbox-1")
            .await
            .unwrap();
        assert_eq!(
            db.get_host_kv("github.delivery.abc")
                .await
                .unwrap()
                .as_deref(),
            Some("outbox-1")
        );
        assert!(!db
            .try_claim_host_kv("github.delivery.abc", "outbox-2")
            .await
            .unwrap());
        assert!(db
            .try_claim_host_kv("github.delivery.new", "outbox-3")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn try_claim_host_kv_is_exclusive_under_concurrency() {
        let db = Db::connect_memory().await.unwrap();
        let db = std::sync::Arc::new(db);
        let mut handles = Vec::new();
        for i in 0..32 {
            let db = db.clone();
            handles.push(tokio::spawn(async move {
                db.try_claim_host_kv("github.delivery.race", &format!("w{i}"))
                    .await
                    .unwrap()
            }));
        }
        let mut wins = 0usize;
        for handle in handles {
            if handle.await.unwrap() {
                wins += 1;
            }
        }
        assert_eq!(wins, 1);
        assert!(db
            .get_host_kv("github.delivery.race")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn backup_outbox_migration_applies_to_an_already_migrated_database() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for (version, sql) in MIGRATIONS {
            if *version == "0008_backup_outbox" {
                continue;
            }
            for statement in split_statements(sql) {
                sqlx::query(&statement).execute(&pool).await.unwrap();
            }
        }
        assert!(sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
            .execute(&pool)
            .await
            .is_err());
        for statement in
            split_statements(include_str!("../../../migrations/0008_backup_outbox.sql"))
        {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query("SELECT attempts FROM outbox_events LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
    }
}
