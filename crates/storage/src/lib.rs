use anyhow::Context;
use async_trait::async_trait;
use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionRecord, Grant, GrantId, Intent, Invocation, InvocationReceipt,
    OrganizationId, ProjectId,
};
use sqlx::{sqlite::SqlitePoolOptions, sqlite::SqliteRow, Row, SqlitePool};
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

fn db_u64(value: i64, field: &str) -> anyhow::Result<u64> {
    u64::try_from(value).with_context(|| format!("negative {field} in database"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncWriteOutcome {
    Accepted,
    BatchAborted,
    ForeignOwner,
    OwnerQuota,
    StoreFull,
    StaleEpoch,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SealedCertificateMaterial {
    pub key_id: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub aad_digest: String,
}

impl std::fmt::Debug for SealedCertificateMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SealedCertificateMaterial")
            .field("key_id", &self.key_id)
            .field("ciphertext", &"[REDACTED]")
            .field("nonce", &"[REDACTED]")
            .field("aad_digest", &self.aad_digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateAuthority {
    pub id: String,
    pub organization_id: String,
    pub issuer_kind: String,
    pub issuer_connection_id: Option<String>,
    pub display_name: String,
    pub public_metadata_json: String,
    pub sealed_material: SealedCertificateMaterial,
    pub is_default: bool,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedCertificateDelivery {
    pub material: SealedCertificateMaterial,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateIssuanceRequest {
    pub id: String,
    pub organization_id: String,
    pub authority_id: String,
    pub request_digest: String,
    pub idempotency_key: String,
    pub created_by: String,
    pub state: String,
    pub common_name: String,
    pub san_json: String,
    pub delivery: Option<SealedCertificateDelivery>,
    pub expires_at: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredIssuedCertificate {
    pub id: String,
    pub organization_id: String,
    pub authority_id: String,
    pub request_id: String,
    pub certificate_digest: String,
    pub serial_number: String,
    pub common_name: String,
    pub san_json: String,
    pub not_before: String,
    pub expires_at: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
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
    (
        "0013_certificate_issuance",
        include_str!("../../../migrations/0013_certificate_issuance.sql"),
    ),
    (
        "0014_custom_providers",
        include_str!("../../../migrations/0014_custom_providers.sql"),
    ),
];

impl Db {
    /// Connect to `SQLite` and apply all pending embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns an error when the database cannot be opened or migrated.
    pub async fn connect_sqlite(url: &str) -> anyhow::Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(if url == "sqlite::memory:" { 1 } else { 5 })
            .connect(url)
            .await?;
        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    /// Open a migrated, process-local `SQLite` database.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` initialization or migration fails.
    pub async fn connect_memory() -> anyhow::Result<Self> {
        Self::connect_sqlite("sqlite::memory:").await
    }

    /// Apply each unapplied embedded migration atomically and in order.
    ///
    /// # Errors
    ///
    /// Returns an error when migration state cannot be read or a migration
    /// transaction cannot be completed.
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

    /// List embedded migration versions already recorded by the database.
    ///
    /// # Errors
    ///
    /// Returns an error when migration records cannot be queried.
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

    #[must_use]
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Report whether the authority is both quorate and unsealed.
    ///
    /// # Errors
    ///
    /// Returns an error when authority health cannot be queried.
    pub async fn authority_quorum_ok(&self) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT quorum_ok, sealed FROM authority_health WHERE id = 1")
            .fetch_one(&self.pool)
            .await?;
        let quorum_ok: i64 = row.get("quorum_ok");
        let sealed: i64 = row.get("sealed");
        Ok(quorum_ok == 1 && sealed == 0)
    }

    /// Update the persisted authority quorum state.
    ///
    /// # Errors
    ///
    /// Returns an error when the health row cannot be updated.
    pub async fn set_authority_quorum(&self, ok: bool) -> anyhow::Result<()> {
        sqlx::query("UPDATE authority_health SET quorum_ok = ?, updated_at = ? WHERE id = 1")
            .bind(i32::from(ok))
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a new organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization violates database constraints or
    /// cannot be inserted.
    pub async fn create_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(id.to_string())
            .bind(name)
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a project belonging to an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization is absent, constraints fail, or
    /// the project cannot be inserted.
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

    /// Validate and atomically persist a provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the transaction cannot be committed.
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

    /// Validate and update an organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the database update fails.
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

    /// Read one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or stored JSON is invalid.
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

    /// List provider connections belonging to one organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or any stored connection is invalid.
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

    /// Delete one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
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

    /// Persist an authorization grant.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
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

    /// Find a grant by identifier, applying the authoritative revocation column.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or stored grant cannot be decoded.
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

    /// Revoke a live grant once.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when a grant is inactive, missing, malformed, or cyclic.
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

    /// Persist an invocation intent and its idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
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

    /// Persist an invocation attempt.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_invocation(&self, inv: &Invocation) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO invocations (id, intent_id, state, attempt, lease_owner, lease_expires_at, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(inv.id.to_string())
        .bind(inv.intent_id.to_string())
        .bind(format!("{:?}", inv.state).to_lowercase())
        .bind(i64::from(inv.attempt))
        .bind(&inv.lease_owner)
        .bind(inv.lease_expires_at.map(|t| t.to_rfc3339()))
        .bind(serde_json::to_string(inv)?)
        .bind(inv.created_at.to_rfc3339())
        .bind(inv.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Persist a signed invocation receipt.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
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

    /// Read a receipt with its authoritative organization binding.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or decoding fails, including when a
    /// receipt claims a different organization from its intent.
    pub async fn get_receipt(
        &self,
        id: &opensesame_domain::ReceiptId,
    ) -> anyhow::Result<Option<StoredReceipt>> {
        let keyed = id.to_string();
        let bare = id.as_uuid().to_string();
        let row = sqlx::query(
            r"
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE r.id = ? OR r.id = ?
            ",
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

    /// Count invocation rows for an intent.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
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

    /// Count all persisted receipts.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_receipts(&self) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) as c FROM receipts")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("c"))
    }

    /// Find the first receipt for an organization-scoped idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when querying or decoding fails, including an invalid
    /// receipt organization binding.
    pub async fn find_receipt_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let row = sqlx::query(
            r"
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE i.organization_id = ? AND i.idempotency_key = ?
            ORDER BY r.created_at ASC
            LIMIT 1
            ",
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

    /// Find an intent by organization and idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or stored intent JSON is invalid.
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

    /// Atomically persist an encrypted item revision and its outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when insertion, outbox creation, or transaction commit
    /// fails.
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

    /// Atomically write an owner-scoped encrypted sync blob and outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range or a database
    /// transaction fails.
    pub async fn write_sync_blob(
        &self,
        owner_id: &str,
        blob: &StoredSyncBlob,
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<SyncWriteOutcome> {
        let outcomes = self
            .write_sync_blobs(
                owner_id,
                std::slice::from_ref(blob),
                store_limit,
                owner_limit,
            )
            .await?;
        outcomes
            .into_iter()
            .next()
            .context("single sync write produced no outcome")
    }

    /// Atomically write a related set of opaque sync blobs.
    ///
    /// If any member conflicts or exceeds quota, no member is written. This
    /// keeps a sealed vault header/body pair at one epoch and gives clients a
    /// reliable pull-merge-retry boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when an epoch exceeds `SQLite`'s range or the database
    /// transaction fails.
    pub async fn write_sync_blobs(
        &self,
        owner_id: &str,
        blobs: &[StoredSyncBlob],
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<Vec<SyncWriteOutcome>> {
        if blobs.is_empty() {
            return Ok(Vec::new());
        }
        let epochs = blobs
            .iter()
            .map(|blob| i64::try_from(blob.epoch).context("sync epoch exceeds SQLite range"))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut transaction = self.pool.begin().await?;
        let store_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
            .fetch_one(&mut *transaction)
            .await?
            .get("count");
        let owner_count: i64 =
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs WHERE owner_id = ?")
                .bind(owner_id)
                .fetch_one(&mut *transaction)
                .await?
                .get("count");

        let mut outcomes = Vec::with_capacity(blobs.len());
        let mut existing = Vec::with_capacity(blobs.len());
        let mut new_count = 0i64;
        for (index, blob) in blobs.iter().enumerate() {
            // ponytail: batches are capped at 64 by the route; a linear scan is
            // smaller than another set allocation. Replace if that cap grows.
            if blobs[..index].iter().any(|prior| prior.id == blob.id) {
                outcomes.push(SyncWriteOutcome::BatchAborted);
                existing.push(false);
                continue;
            }
            let row = sqlx::query("SELECT owner_id, epoch FROM encrypted_sync_blobs WHERE id = ?")
                .bind(&blob.id)
                .fetch_optional(&mut *transaction)
                .await?;
            let outcome = match row {
                Some(ref row) if row.get::<String, _>("owner_id") != owner_id => {
                    SyncWriteOutcome::ForeignOwner
                }
                Some(ref row) if row.get::<i64, _>("epoch") >= epochs[index] => {
                    SyncWriteOutcome::StaleEpoch
                }
                Some(_) => SyncWriteOutcome::Accepted,
                None if store_count + new_count >= store_limit => SyncWriteOutcome::StoreFull,
                None if owner_count + new_count >= owner_limit => SyncWriteOutcome::OwnerQuota,
                None => {
                    new_count += 1;
                    SyncWriteOutcome::Accepted
                }
            };
            existing.push(row.is_some());
            outcomes.push(outcome);
        }

        if outcomes
            .iter()
            .any(|outcome| *outcome != SyncWriteOutcome::Accepted)
        {
            for outcome in outcomes
                .iter_mut()
                .filter(|outcome| **outcome == SyncWriteOutcome::Accepted)
            {
                *outcome = SyncWriteOutcome::BatchAborted;
            }
            return Ok(outcomes);
        }

        let updated_at = Utc::now().to_rfc3339();
        for ((blob, epoch), exists) in blobs.iter().zip(epochs).zip(existing) {
            if exists {
                sqlx::query(
                    "UPDATE encrypted_sync_blobs SET epoch = ?, ciphertext = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                )
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .bind(&blob.id)
                .bind(owner_id)
                .execute(&mut *transaction)
                .await?;
            } else {
                sqlx::query(
                    "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&blob.id)
                .bind(owner_id)
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .execute(&mut *transaction)
                .await?;
            }
            append_sync_blob_outbox(&mut transaction, owner_id, &blob.id, epoch).await?;
        }
        transaction.commit().await?;
        Ok(outcomes)
    }

    /// List owner-scoped encrypted sync blobs newer than `since_epoch`.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_sync_blobs(
        &self,
        owner_id: &str,
        since_epoch: u64,
    ) -> anyhow::Result<Vec<StoredSyncBlob>> {
        let Ok(since_epoch) = i64::try_from(since_epoch) else {
            return Ok(vec![]);
        };
        let rows = sqlx::query(
            "SELECT id, epoch, ciphertext FROM encrypted_sync_blobs WHERE owner_id = ? AND epoch > ? ORDER BY epoch, id",
        )
        .bind(owner_id)
        .bind(since_epoch)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(StoredSyncBlob {
                    id: row.get("id"),
                    epoch: db_u64(row.get("epoch"), "sync epoch")?,
                    ciphertext: row.get("ciphertext"),
                })
            })
            .collect()
    }

    /// Count all encrypted sync blobs.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_sync_blobs(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    /// Advance an owner/device sync cursor without allowing it to move backward.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range, database access
    /// fails, or a stored cursor is negative.
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
        .get::<i64, _>("epoch");
        let cursor = db_u64(cursor, "sync cursor")?;
        transaction.commit().await?;
        Ok(Some(cursor))
    }

    // —— transactional outbox (ADR 0039) ————————————————————————

    /// Broadcast a change event in its own transaction. Mutations that already
    /// hold a transaction use [`append_outbox_tx`] instead, so the event and
    /// the change it describes commit or roll back together.
    ///
    /// # Errors
    ///
    /// Returns an error when the outbox row or transaction cannot be committed.
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
    ///
    /// # Errors
    ///
    /// Returns an error when due events cannot be queried, leased, or committed.
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

    /// Mark selected outbox events as published in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
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

    /// Count outbox events that have not been published.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_unpublished_outbox(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM outbox_events WHERE published_at IS NULL")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    // —— certificate authority and issuance —————————————————————

    /// Insert a sealed certificate authority.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, serialization, or persistence fails.
    pub async fn insert_certificate_authority(
        &self,
        authority: &StoredCertificateAuthority,
    ) -> anyhow::Result<()> {
        validate_sealed_material(&authority.sealed_material)?;
        if authority.is_default && authority.status != "active" {
            anyhow::bail!("only an active certificate authority may be default");
        }
        serde_json::from_str::<serde_json::Value>(&authority.public_metadata_json)
            .context("certificate authority public metadata is not valid JSON")?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(&authority.organization_id)
            .bind(&authority.organization_id)
            .bind(&authority.created_at)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_authorities (id, organization_id, issuer_kind, issuer_connection_id, display_name, public_metadata_json, sealed_key_id, sealed_ciphertext, sealed_nonce, sealed_aad_digest, is_default, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&authority.id)
        .bind(&authority.organization_id)
        .bind(&authority.issuer_kind)
        .bind(&authority.issuer_connection_id)
        .bind(&authority.display_name)
        .bind(&authority.public_metadata_json)
        .bind(&authority.sealed_material.key_id)
        .bind(&authority.sealed_material.ciphertext)
        .bind(&authority.sealed_material.nonce)
        .bind(&authority.sealed_material.aad_digest)
        .bind(i64::from(authority.is_default))
        .bind(&authority.status)
        .bind(authority.version)
        .bind(&authority.created_at)
        .bind(&authority.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_default_certificate_authority(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND is_default = 1",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_authorities(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateAuthority>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? ORDER BY is_default DESC, created_at, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_authority).collect())
    }

    /// Select one active default using compare-and-swap. This never falls back
    /// to another issuer when the selected row is absent, stale, or inactive.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn set_default_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
    ) -> anyhow::Result<bool> {
        let mut transaction = self.pool.begin().await?;
        let target = sqlx::query(
            "SELECT version, status FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(target) = target else {
            return Ok(false);
        };
        if target.get::<i64, _>("version") != expected_version
            || target.get::<String, _>("status") != "active"
        {
            return Ok(false);
        }
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE certificate_authorities SET is_default = 0, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND is_default = 1 AND id <> ?",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE certificate_authorities SET is_default = 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND status = 'active'",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_certificate_authority_status(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE certificate_authorities SET status = ?, is_default = CASE WHEN ? = 'active' THEN is_default ELSE 0 END, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(status)
        .bind(status)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when validation or insertion fails.
    pub async fn insert_certificate_issuance_request(
        &self,
        request: &StoredCertificateIssuanceRequest,
    ) -> anyhow::Result<bool> {
        validate_san_json(&request.san_json)?;
        if request.state != "created" || request.delivery.is_some() {
            anyhow::bail!("new certificate issuance requests must be unfulfilled and created");
        }
        let result = sqlx::query(
            "INSERT INTO certificate_issuance_requests (id, organization_id, authority_id, request_digest, idempotency_key, created_by, state, common_name, san_json, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at, expires_at, version, created_at, updated_at) \
             SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM certificate_authorities \
             WHERE id = ? AND organization_id = ? AND status = 'active'",
        )
        .bind(&request.id)
        .bind(&request.organization_id)
        .bind(&request.request_digest)
        .bind(&request.idempotency_key)
        .bind(&request.created_by)
        .bind(&request.state)
        .bind(&request.common_name)
        .bind(&request.san_json)
        .bind(request.delivery.as_ref().map(|d| &d.material.key_id))
        .bind(request.delivery.as_ref().map(|d| &d.material.ciphertext))
        .bind(request.delivery.as_ref().map(|d| &d.material.nonce))
        .bind(request.delivery.as_ref().map(|d| &d.material.aad_digest))
        .bind(request.delivery.as_ref().map(|d| &d.expires_at))
        .bind(&request.expires_at)
        .bind(request.version)
        .bind(&request.created_at)
        .bind(&request.updated_at)
        .bind(&request.authority_id)
        .bind(&request.organization_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup or stored-record decoding fails.
    pub async fn find_certificate_issuance_by_idempotency(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<Option<StoredCertificateIssuanceRequest>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_issuance_requests WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(stored_certificate_issuance_request)
            .transpose()
    }

    /// # Errors
    ///
    /// Returns an error when the state update fails.
    pub async fn transition_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        next_state: &str,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) || next_state == "completed" {
            return Ok(false);
        }
        let result = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(next_state)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Atomically records key-free certificate metadata and the encrypted,
    /// time-bounded delivery payload. A stale request cannot create a record.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the transaction fails.
    pub async fn complete_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        delivery: &SealedCertificateDelivery,
        issued: &StoredIssuedCertificate,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) {
            return Ok(false);
        }
        validate_sealed_material(&delivery.material)?;
        validate_san_json(&issued.san_json)?;
        if issued.organization_id != organization_id || issued.request_id != request_id {
            anyhow::bail!("issued certificate ownership does not match request");
        }
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = 'completed', delivery_key_id = ?, delivery_ciphertext = ?, delivery_nonce = ?, delivery_aad_digest = ?, delivery_expires_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND authority_id = ? AND common_name = ? AND san_json = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(&delivery.material.key_id)
        .bind(&delivery.material.ciphertext)
        .bind(&delivery.material.nonce)
        .bind(&delivery.material.aad_digest)
        .bind(&delivery.expires_at)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(&issued.authority_id)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&issued.id)
        .bind(&issued.organization_id)
        .bind(&issued.authority_id)
        .bind(&issued.request_id)
        .bind(&issued.certificate_digest)
        .bind(&issued.serial_number)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(&issued.not_before)
        .bind(&issued.expires_at)
        .bind(&issued.status)
        .bind(issued.version)
        .bind(&issued.created_at)
        .bind(&issued.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(true)
    }

    /// Destructive read of a still-valid encrypted delivery. The clear and
    /// version bump happen in the same transaction, so concurrent readers get
    /// at most one payload.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn take_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        if !clear_certificate_delivery(&mut transaction, request_id, version).await? {
            transaction.rollback().await?;
            return Ok(None);
        }
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Reads a bounded encrypted delivery without consuming it. Callers must
    /// acknowledge only after the response has been durably stored by the
    /// holder; this avoids losing a generated private key on transport failure.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn get_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Clears an encrypted delivery after holder acknowledgement. The CAS makes
    /// repeated or concurrent acknowledgements harmless.
    ///
    /// # Errors
    ///
    /// Returns an error when the lookup or transaction fails.
    pub async fn acknowledge_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT version FROM certificate_issuance_requests \
             WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed' AND delivery_ciphertext IS NOT NULL",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let mut transaction = self.pool.begin().await?;
        let cleared =
            clear_certificate_delivery(&mut transaction, request_id, row.get::<i64, _>("version"))
                .await?;
        transaction.commit().await?;
        Ok(cleared)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_issued_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredIssuedCertificate>> {
        let row =
            sqlx::query("SELECT * FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_issued_certificate))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_issued_certificates_expiring_before(
        &self,
        organization_id: &str,
        before: &str,
    ) -> anyhow::Result<Vec<StoredIssuedCertificate>> {
        let rows = sqlx::query(
            "SELECT * FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?) ORDER BY expires_at, id",
        )
        .bind(organization_id)
        .bind(before)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_issued_certificate).collect())
    }

    // —— host operator kv ————————————————————————————————

    /// Read a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_host_kv(&self, key: &str) -> anyhow::Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM host_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    /// Insert or replace a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
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

    /// Delete a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_host_kv(&self, key: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM host_kv WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // —— backup targets (ADR 0039) ——————————————————————————————

    /// Insert or update the encrypted-backup target for an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
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

    /// Read an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when the database update fails.
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

    /// Insert or update an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn upsert_attachment_target(&self, target: &AttachmentTarget) -> anyhow::Result<()> {
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

    /// Read an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
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
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
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

    /// Delete an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_attachment_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM attachment_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_backup_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM backup_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Ciphertext rows a snapshot is built from. Only sealed bytes leave this
    /// query; there is no plaintext anywhere in the backup path.
    ///
    /// # Errors
    ///
    /// Returns an error when encrypted revisions cannot be queried.
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

    /// List every owner-scoped encrypted sync blob for snapshot backup.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_all_sync_blobs(&self) -> anyhow::Result<Vec<(String, StoredSyncBlob)>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, epoch, ciphertext FROM encrypted_sync_blobs ORDER BY owner_id, epoch, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok((
                    row.get("owner_id"),
                    StoredSyncBlob {
                        id: row.get("id"),
                        epoch: db_u64(row.get("epoch"), "sync epoch")?,
                        ciphertext: row.get("ciphertext"),
                    },
                ))
            })
            .collect()
    }
}

fn validate_sealed_material(material: &SealedCertificateMaterial) -> anyhow::Result<()> {
    if material.key_id.is_empty()
        || material.ciphertext.is_empty()
        || material.nonce.is_empty()
        || material.aad_digest.is_empty()
    {
        anyhow::bail!("sealed certificate material must be complete");
    }
    Ok(())
}

fn validate_san_json(san_json: &str) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sans {
        dns_names: Vec<String>,
        ip_addrs: Vec<String>,
    }
    let sans: Sans = serde_json::from_str(san_json)
        .context("certificate SAN metadata must contain DNS names and IP addresses")?;
    if sans.dns_names.len() > 100
        || sans.ip_addrs.len() > 16
        || sans
            .dns_names
            .iter()
            .chain(&sans.ip_addrs)
            .any(|value| value.is_empty() || value.len() > 253)
    {
        anyhow::bail!("certificate SAN metadata exceeds bounds");
    }
    Ok(())
}

fn stored_certificate_authority(row: &SqliteRow) -> StoredCertificateAuthority {
    StoredCertificateAuthority {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        issuer_kind: row.get("issuer_kind"),
        issuer_connection_id: row.get("issuer_connection_id"),
        display_name: row.get("display_name"),
        public_metadata_json: row.get("public_metadata_json"),
        sealed_material: SealedCertificateMaterial {
            key_id: row.get("sealed_key_id"),
            ciphertext: row.get("sealed_ciphertext"),
            nonce: row.get("sealed_nonce"),
            aad_digest: row.get("sealed_aad_digest"),
        },
        is_default: row.get::<i64, _>("is_default") != 0,
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_certificate_issuance_request(
    row: &SqliteRow,
) -> anyhow::Result<StoredCertificateIssuanceRequest> {
    let delivery = match row.get::<Option<String>, _>("delivery_key_id") {
        Some(key_id) => Some(SealedCertificateDelivery {
            material: SealedCertificateMaterial {
                key_id,
                ciphertext: row
                    .get::<Option<Vec<u8>>, _>("delivery_ciphertext")
                    .context("certificate delivery ciphertext is missing")?,
                nonce: row
                    .get::<Option<Vec<u8>>, _>("delivery_nonce")
                    .context("certificate delivery nonce is missing")?,
                aad_digest: row
                    .get::<Option<String>, _>("delivery_aad_digest")
                    .context("certificate delivery AAD digest is missing")?,
            },
            expires_at: row
                .get::<Option<String>, _>("delivery_expires_at")
                .context("certificate delivery expiry is missing")?,
        }),
        None => None,
    };
    Ok(StoredCertificateIssuanceRequest {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        authority_id: row.get("authority_id"),
        request_digest: row.get("request_digest"),
        idempotency_key: row.get("idempotency_key"),
        created_by: row.get("created_by"),
        state: row.get("state"),
        common_name: row.get("common_name"),
        san_json: row.get("san_json"),
        delivery,
        expires_at: row.get("expires_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn stored_issued_certificate(row: &SqliteRow) -> StoredIssuedCertificate {
    StoredIssuedCertificate {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        authority_id: row.get("authority_id"),
        request_id: row.get("request_id"),
        certificate_digest: row.get("certificate_digest"),
        serial_number: row.get("serial_number"),
        common_name: row.get("common_name"),
        san_json: row.get("san_json"),
        not_before: row.get("not_before"),
        expires_at: row.get("expires_at"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn sealed_certificate_delivery(row: &SqliteRow) -> anyhow::Result<SealedCertificateDelivery> {
    Ok(SealedCertificateDelivery {
        material: SealedCertificateMaterial {
            key_id: row
                .get::<Option<String>, _>("delivery_key_id")
                .context("certificate delivery key ID is missing")?,
            ciphertext: row
                .get::<Option<Vec<u8>>, _>("delivery_ciphertext")
                .context("certificate delivery ciphertext is missing")?,
            nonce: row
                .get::<Option<Vec<u8>>, _>("delivery_nonce")
                .context("certificate delivery nonce is missing")?,
            aad_digest: row
                .get::<Option<String>, _>("delivery_aad_digest")
                .context("certificate delivery AAD digest is missing")?,
        },
        expires_at: row
            .get::<Option<String>, _>("delivery_expires_at")
            .context("certificate delivery expiry is missing")?,
    })
}

async fn clear_certificate_delivery(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request_id: &str,
    expected_version: i64,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        "UPDATE certificate_issuance_requests SET delivery_key_id = NULL, delivery_ciphertext = NULL, delivery_nonce = NULL, delivery_aad_digest = NULL, delivery_expires_at = NULL, version = version + 1, updated_at = ? \
         WHERE id = ? AND version = ? AND delivery_ciphertext IS NOT NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(request_id)
    .bind(expected_version)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected() == 1)
}

fn certificate_issuance_state_is_terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "expired" | "revoked")
}

fn certificate_time_is_expired(expires_at: &str, now: &str) -> anyhow::Result<bool> {
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at)
        .context("certificate delivery expiry is not RFC 3339")?;
    let now = chrono::DateTime::parse_from_rfc3339(now)
        .context("certificate delivery comparison time is not RFC 3339")?;
    Ok(expires_at <= now)
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
///
/// # Errors
///
/// Returns an error when the outbox row cannot be inserted.
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

#[must_use]
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

    async fn apply_migration(pool: &SqlitePool, migration: &str) {
        for statement in split_statements(migration) {
            sqlx::query(&statement).execute(pool).await.unwrap();
        }
    }

    async fn apply_migrations(pool: &SqlitePool, migrations: &[(&str, &str)]) {
        for (_, migration) in migrations {
            apply_migration(pool, migration).await;
        }
    }

    async fn apply_migrations_except(
        pool: &SqlitePool,
        migrations: &[(&str, &str)],
        excluded_version: &str,
    ) {
        for (version, migration) in migrations {
            if *version != excluded_version {
                apply_migration(pool, migration).await;
            }
        }
    }

    async fn claim_host_kv(db: std::sync::Arc<Db>, worker: usize) -> bool {
        db.try_claim_host_kv("github.delivery.race", &format!("w{worker}"))
            .await
            .unwrap()
    }

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

    fn certificate_authority(
        organization_id: &str,
        id: &str,
        is_default: bool,
    ) -> StoredCertificateAuthority {
        StoredCertificateAuthority {
            id: id.into(),
            organization_id: organization_id.into(),
            issuer_kind: "opensesame_private_ca".into(),
            issuer_connection_id: None,
            display_name: "OpenSesame Private CA".into(),
            public_metadata_json: r#"{"algorithm":"ES256"}"#.into(),
            sealed_material: SealedCertificateMaterial {
                key_id: "seal:v1".into(),
                ciphertext: vec![1, 2, 3],
                nonce: vec![4, 5, 6],
                aad_digest: "sha256:authority".into(),
            },
            is_default,
            status: "active".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn certificate_request(
        organization_id: &str,
        authority_id: &str,
        id: &str,
        idempotency_key: &str,
    ) -> StoredCertificateIssuanceRequest {
        StoredCertificateIssuanceRequest {
            id: id.into(),
            organization_id: organization_id.into(),
            authority_id: authority_id.into(),
            request_digest: format!("sha256:{id}"),
            idempotency_key: idempotency_key.into(),
            created_by: "principal:owner".into(),
            state: "created".into(),
            common_name: "localhost".into(),
            san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
            delivery: None,
            expires_at: "2099-01-01T00:00:00+00:00".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn issued_certificate(
        organization_id: &str,
        authority_id: &str,
        request_id: &str,
        id: &str,
    ) -> StoredIssuedCertificate {
        StoredIssuedCertificate {
            id: id.into(),
            organization_id: organization_id.into(),
            authority_id: authority_id.into(),
            request_id: request_id.into(),
            certificate_digest: format!("sha256:{id}"),
            serial_number: id.into(),
            common_name: "localhost".into(),
            san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
            not_before: "2026-08-21T00:00:00+00:00".into(),
            expires_at: "2026-08-22T00:00:00+00:00".into(),
            status: "active".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn certificate_delivery(expires_at: &str) -> SealedCertificateDelivery {
        SealedCertificateDelivery {
            material: SealedCertificateMaterial {
                key_id: "seal:v1".into(),
                ciphertext: vec![9, 8, 7],
                nonce: vec![6, 5, 4],
                aad_digest: "sha256:delivery".into(),
            },
            expires_at: expires_at.into(),
        }
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
            db.write_sync_blob("principal:alice", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::StaleEpoch
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
    async fn encrypted_sync_batch_is_atomic_on_equal_epoch_conflict() {
        let db = Db::connect_memory().await.unwrap();
        let header = StoredSyncBlob {
            id: "vault:header".into(),
            epoch: 1,
            ciphertext: vec![1],
        };
        let body = StoredSyncBlob {
            id: "vault:body".into(),
            epoch: 1,
            ciphertext: vec![2],
        };
        assert_eq!(
            db.write_sync_blobs("owner", &[header.clone(), body.clone()], 10, 10)
                .await
                .unwrap(),
            vec![SyncWriteOutcome::Accepted, SyncWriteOutcome::Accepted]
        );

        let conflicting_header = StoredSyncBlob {
            ciphertext: vec![9],
            ..header
        };
        let newer_body = StoredSyncBlob {
            epoch: 2,
            ciphertext: vec![8],
            ..body
        };
        assert_eq!(
            db.write_sync_blobs("owner", &[conflicting_header, newer_body], 10, 10)
                .await
                .unwrap(),
            vec![SyncWriteOutcome::StaleEpoch, SyncWriteOutcome::BatchAborted]
        );
        let stored = db.list_sync_blobs("owner", 0).await.unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().all(|blob| blob.epoch == 1));
        assert!(stored
            .iter()
            .any(|blob| blob.id == "vault:body" && blob.ciphertext == vec![2]));
    }

    #[test]
    fn database_unsigned_values_reject_negative_storage() {
        assert_eq!(db_u64(0, "epoch").unwrap(), 0);
        assert_eq!(
            db_u64(i64::MAX, "epoch").unwrap(),
            u64::try_from(i64::MAX).unwrap()
        );
        assert!(db_u64(-1, "epoch").is_err());
    }

    #[tokio::test]
    async fn sync_epoch_boundaries_fail_closed() {
        let db = Db::connect_memory().await.unwrap();
        let too_large = StoredSyncBlob {
            id: "too-large".into(),
            epoch: u64::try_from(i64::MAX).unwrap() + 1,
            ciphertext: vec![1],
        };
        assert!(db
            .write_sync_blob("owner", &too_large, 10, 10)
            .await
            .is_err());

        sqlx::query(
            "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) \
             VALUES ('corrupt', 'owner', -1, X'01', 't')",
        )
        .execute(db.pool())
        .await
        .unwrap();
        assert!(db.list_all_sync_blobs().await.is_err());
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
                .map(|(v, _)| (*v).to_string())
                .collect::<Vec<_>>()
        );

        // A second boot must be a no-op rather than replaying schema changes.
        db.migrate().await.unwrap();
        assert_eq!(db.applied_migrations().await.unwrap(), applied);
    }

    #[tokio::test]
    async fn migration_preserves_legacy_certificate_host_kv() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        apply_migrations(&pool, &MIGRATIONS[..10]).await;
        sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES ('certs.dev_ca', 'legacy-unsealed-value', 't')",
        )
        .execute(&pool)
        .await
        .unwrap();
        apply_migration(
            &pool,
            include_str!("../../../migrations/0013_certificate_issuance.sql"),
        )
        .await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM host_kv WHERE key = 'certs.dev_ca'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "legacy-unsealed-value"
        );
    }

    #[tokio::test]
    async fn atomic_certificate_authority_default_is_org_scoped_and_cas_guarded() {
        let db = Db::connect_memory().await.unwrap();
        let internal = certificate_authority("org:one", "ca:internal", true);
        let external = certificate_authority("org:one", "ca:external", false);
        db.insert_certificate_authority(&internal).await.unwrap();
        db.insert_certificate_authority(&external).await.unwrap();

        assert!(!db
            .set_default_certificate_authority("org:two", "ca:external", 1)
            .await
            .unwrap());
        assert!(db
            .set_default_certificate_authority("org:one", "ca:external", 1)
            .await
            .unwrap());
        assert_eq!(
            db.get_default_certificate_authority("org:one")
                .await
                .unwrap()
                .unwrap()
                .id,
            "ca:external"
        );
        assert!(!db
            .set_default_certificate_authority("org:one", "ca:internal", 1)
            .await
            .unwrap());

        let duplicate_default = certificate_authority("org:one", "ca:duplicate", true);
        assert!(db
            .insert_certificate_authority(&duplicate_default)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_certificate_completion_rejects_substitution_and_replay() {
        let db = Db::connect_memory().await.unwrap();
        let authority = certificate_authority("org:one", "ca:one", true);
        db.insert_certificate_authority(&authority).await.unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        assert!(db
            .insert_certificate_issuance_request(&request)
            .await
            .unwrap());

        let mut duplicate = certificate_request("org:one", "ca:one", "request:two", "idem:one");
        duplicate.request_digest = "sha256:other".into();
        assert!(db
            .insert_certificate_issuance_request(&duplicate)
            .await
            .is_err());

        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        let mut substituted =
            issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        substituted.common_name = "attacker.example".into();
        assert!(!db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &substituted,
            )
            .await
            .unwrap());

        let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        assert!(db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &issued,
            )
            .await
            .unwrap());
        assert!(!db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &issued,
            )
            .await
            .unwrap());
        assert_eq!(
            db.get_issued_certificate("org:one", "certificate:one")
                .await
                .unwrap(),
            Some(issued)
        );
        assert!(db
            .get_issued_certificate("org:two", "certificate:one")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn atomic_certificate_delivery_is_encrypted_expiring_and_single_use() {
        let db = Db::connect_memory().await.unwrap();
        let authority = certificate_authority("org:one", "ca:one", true);
        db.insert_certificate_authority(&authority).await.unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        db.insert_certificate_issuance_request(&request)
            .await
            .unwrap();
        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        let debug = format!("{delivery:?}");
        assert!(!debug.contains("[9, 8, 7]"));
        assert!(!debug.contains("[6, 5, 4]"));
        let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        db.complete_certificate_issuance(
            "org:one",
            "request:one",
            1,
            "created",
            &delivery,
            &issued,
        )
        .await
        .unwrap();

        assert!(db
            .take_certificate_delivery("org:two", "request:one", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            db.take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
                .await
                .unwrap(),
            Some(delivery)
        );
        assert!(db
            .take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());

        let expired_request =
            certificate_request("org:one", "ca:one", "request:expired", "idem:expired");
        db.insert_certificate_issuance_request(&expired_request)
            .await
            .unwrap();
        let expired_issued = issued_certificate(
            "org:one",
            "ca:one",
            "request:expired",
            "certificate:expired",
        );
        db.complete_certificate_issuance(
            "org:one",
            "request:expired",
            1,
            "created",
            &certificate_delivery("2026-08-20T00:00:00+00:00"),
            &expired_issued,
        )
        .await
        .unwrap();
        assert!(db
            .take_certificate_delivery("org:one", "request:expired", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());
        assert!(sqlx::query_scalar::<_, Option<Vec<u8>>>(
            "SELECT delivery_ciphertext FROM certificate_issuance_requests WHERE id = 'request:expired'",
        )
        .fetch_one(db.pool())
        .await
        .unwrap()
        .is_none());

        let columns = sqlx::query("PRAGMA table_info(issued_certificates)")
            .fetch_all(db.pool())
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert!(columns.iter().all(|column| {
            !column.contains("private")
                && !column.contains("ciphertext")
                && !column.contains("nonce")
        }));
    }

    #[tokio::test]
    async fn contract_certificate_delivery_retries_until_holder_acknowledges() {
        let db = Db::connect_memory().await.unwrap();
        db.insert_certificate_authority(&certificate_authority("org:one", "ca:one", true))
            .await
            .unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        db.insert_certificate_issuance_request(&request)
            .await
            .unwrap();
        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        db.complete_certificate_issuance(
            "org:one",
            "request:one",
            1,
            "created",
            &delivery,
            &issued_certificate("org:one", "ca:one", "request:one", "certificate:one"),
        )
        .await
        .unwrap();

        assert!(db
            .get_certificate_delivery(
                "org:one",
                "request:one",
                "principal:attacker",
                "2026-08-21T00:00:00+00:00",
            )
            .await
            .unwrap()
            .is_none());
        for _ in 0..2 {
            assert_eq!(
                db.get_certificate_delivery(
                    "org:one",
                    "request:one",
                    "principal:owner",
                    "2026-08-21T00:00:00+00:00",
                )
                .await
                .unwrap(),
                Some(delivery.clone())
            );
        }
        assert!(db
            .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
            .await
            .unwrap());
        assert!(db
            .get_certificate_delivery(
                "org:one",
                "request:one",
                "principal:owner",
                "2026-08-21T00:00:00+00:00",
            )
            .await
            .unwrap()
            .is_none());
        assert!(!db
            .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
            .await
            .unwrap());
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
        apply_migrations(&pool, &MIGRATIONS[..4]).await;
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
        apply_migrations(&pool, &MIGRATIONS[..5]).await;
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
        apply_migrations(&pool, &MIGRATIONS[..6]).await;
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
            handles.push(tokio::spawn(claim_host_kv(db.clone(), i)));
        }
        let mut wins = 0usize;
        for handle in handles {
            wins += usize::from(handle.await.unwrap());
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
        apply_migrations_except(&pool, MIGRATIONS, "0008_backup_outbox").await;
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
