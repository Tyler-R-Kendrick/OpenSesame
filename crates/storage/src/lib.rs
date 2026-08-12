use anyhow::Context;
use async_trait::async_trait;
use chrono::Utc;
use opensesame_domain::{Grant, Intent, Invocation, InvocationReceipt, OrganizationId, ProjectId};
use std::{path::Path, time::Duration};
use turso::{params, Connection, IntoParams, Rows};

#[derive(Clone)]
pub struct Db {
    backend: Backend,
}

#[derive(Clone)]
enum Backend {
    Local(turso::Database),
    Synced(turso::sync::Database),
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
];

impl Db {
    /// Open Turso embedded storage. When `remote_url` is present the local file
    /// syncs with Turso Cloud or a self-hosted `tursodb --sync-server` endpoint.
    pub async fn connect_turso(
        path: &str,
        remote_url: Option<&str>,
        auth_token: Option<&str>,
    ) -> anyhow::Result<Self> {
        let path = turso_path(path);
        ensure_parent(&path)?;
        let backend = if let Some(remote_url) = remote_url.filter(|url| !url.is_empty()) {
            let mut builder = turso::sync::Builder::new_remote(&path)
                .with_remote_url(remote_url)
                .with_client_name("opensesame-host");
            if let Some(token) = auth_token.filter(|token| !token.is_empty()) {
                builder = builder.with_auth_token(token);
            }
            Backend::Synced(builder.build().await?)
        } else {
            Backend::Local(turso::Builder::new_local(&path).build().await?)
        };
        let db = Self { backend };
        db.migrate().await?;
        if matches!(db.backend, Backend::Synced(_)) {
            db.sync_now().await.context("initial Turso sync")?;
            db.start_sync_loop();
        }
        Ok(db)
    }

    /// Compatibility shim for existing operators; SQLite URLs are interpreted
    /// as paths and opened by the Turso embedded engine.
    pub async fn connect_sqlite(url: &str) -> anyhow::Result<Self> {
        Self::connect_turso(url, None, None).await
    }

    pub async fn connect_memory() -> anyhow::Result<Self> {
        Self::connect_turso(":memory:", None, None).await
    }

    pub async fn connection(&self) -> turso::Result<Connection> {
        match &self.backend {
            Backend::Local(db) => db.connect(),
            Backend::Synced(db) => db.connect().await,
        }
    }

    pub async fn execute(
        &self,
        sql: impl AsRef<str>,
        params: impl IntoParams,
    ) -> turso::Result<u64> {
        self.connection().await?.execute(sql, params).await
    }

    pub async fn query(
        &self,
        sql: impl AsRef<str>,
        params: impl IntoParams,
    ) -> turso::Result<Rows> {
        self.connection().await?.query(sql, params).await
    }

    pub async fn after_write(&self) {
        if let Backend::Synced(db) = &self.backend {
            if let Err(error) = db.push().await {
                tracing::warn!(%error, "Turso push failed; local changes will retry");
            }
        }
    }

    async fn sync_now(&self) -> turso::Result<()> {
        if let Backend::Synced(db) = &self.backend {
            db.pull().await?;
            db.push().await?;
        }
        Ok(())
    }

    fn start_sync_loop(&self) {
        let db = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = db.sync_now().await {
                    tracing::warn!(%error, "Turso background sync failed");
                }
            }
        });
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        self.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
            (),
        )
        .await
        .context("creating schema_migrations")?;

        for (version, sql) in MIGRATIONS {
            if self.migration_applied(version).await? {
                continue;
            }
            // A version lands whole or not at all, so a failure mid-file cannot
            // leave a database that reports itself migrated.
            let mut conn = self.connection().await?;
            let tx = conn.transaction().await?;
            for stmt in split_statements(sql) {
                tx.execute(&stmt, ())
                    .await
                    .with_context(|| format!("migration {version}: {stmt}"))?;
            }
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                params![version.to_string(), Utc::now().to_rfc3339()],
            )
            .await?;
            tx.commit().await?;
            self.after_write().await;
            tracing::info!(migration = version, "schema migration applied");
        }
        Ok(())
    }

    pub async fn applied_migrations(&self) -> anyhow::Result<Vec<String>> {
        let mut rows = self
            .query(
                "SELECT version FROM schema_migrations ORDER BY version ASC",
                (),
            )
            .await?;
        let mut versions = Vec::new();
        while let Some(row) = rows.next().await? {
            versions.push(row.get(0)?);
        }
        Ok(versions)
    }

    async fn migration_applied(&self, version: &str) -> anyhow::Result<bool> {
        let mut rows = self
            .query(
                "SELECT 1 AS present FROM schema_migrations WHERE version = ?",
                [version],
            )
            .await?;
        Ok(rows.next().await?.is_some())
    }

    pub async fn authority_quorum_ok(&self) -> anyhow::Result<bool> {
        let mut rows = self
            .query(
                "SELECT quorum_ok, sealed FROM authority_health WHERE id = 1",
                (),
            )
            .await?;
        let row = rows.next().await?.context("authority health row missing")?;
        let quorum_ok: i64 = row.get(0)?;
        let sealed: i64 = row.get(1)?;
        Ok(quorum_ok == 1 && sealed == 0)
    }

    pub async fn set_authority_quorum(&self, ok: bool) -> anyhow::Result<()> {
        self.execute(
            "UPDATE authority_health SET quorum_ok = ?, updated_at = ? WHERE id = 1",
            params![if ok { 1_i64 } else { 0_i64 }, Utc::now().to_rfc3339()],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn create_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
            params![id.to_string(), name, Utc::now().to_rfc3339()],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn create_project(
        &self,
        id: &ProjectId,
        org: &OrganizationId,
        name: &str,
    ) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)",
            params![
                id.to_string(),
                org.to_string(),
                name,
                Utc::now().to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn ensure_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
            params![id.to_string(), name, Utc::now().to_rfc3339()],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn ensure_project(
        &self,
        id: &ProjectId,
        org: &OrganizationId,
        name: &str,
    ) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
            params![id.to_string(), org.to_string(), name, Utc::now().to_rfc3339()],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn insert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                grant.id.to_string(),
                grant.organization_id.to_string(),
                serde_json::to_string(grant)?,
                grant.revoked_at.map(|t| t.to_rfc3339()),
                grant.created_at.to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn upsert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET organization_id = excluded.organization_id, body_json = excluded.body_json, \
             revoked_at = excluded.revoked_at, created_at = excluded.created_at",
            params![
                grant.id.to_string(),
                grant.organization_id.to_string(),
                serde_json::to_string(grant)?,
                grant.revoked_at.map(|t| t.to_rfc3339()),
                grant.created_at.to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn insert_intent(&self, intent: &Intent) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO intents (id, organization_id, body_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                intent.id.to_string(),
                intent.organization_id.to_string(),
                serde_json::to_string(intent)?,
                intent.idempotency_key.clone(),
                intent.issued_at.to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn insert_invocation(&self, inv: &Invocation) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO invocations (id, intent_id, state, attempt, lease_owner, lease_expires_at, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                inv.id.to_string(),
                inv.intent_id.to_string(),
                format!("{:?}", inv.state).to_lowercase(),
                inv.attempt as i64,
                inv.lease_owner.clone(),
                inv.lease_expires_at.map(|t| t.to_rfc3339()),
                serde_json::to_string(inv)?,
                inv.created_at.to_rfc3339(),
                inv.updated_at.to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn insert_receipt(&self, receipt: &InvocationReceipt) -> anyhow::Result<()> {
        self.execute(
            "INSERT INTO receipts (id, invocation_id, body_json, signature, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                receipt.id.to_string(),
                receipt.invocation_id.to_string(),
                serde_json::to_string(receipt)?,
                receipt.signature.clone(),
                receipt.completed_at.to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
    }

    pub async fn get_receipt(
        &self,
        id: &opensesame_domain::ReceiptId,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let keyed = id.to_string();
        let bare = id.as_uuid().to_string();
        let mut rows = self
            .query(
                "SELECT id, body_json FROM receipts WHERE id = ? OR id = ?",
                params![keyed, bare],
            )
            .await?;
        Ok(match rows.next().await? {
            Some(r) => {
                let body: String = r.get(1)?;
                Some(serde_json::from_str(&body)?)
            }
            None => None,
        })
    }

    pub async fn count_invocations_for_intent(
        &self,
        intent_id: &opensesame_domain::IntentId,
    ) -> anyhow::Result<i64> {
        let mut rows = self
            .query(
                "SELECT COUNT(*) as c FROM invocations WHERE intent_id = ?",
                [intent_id.to_string()],
            )
            .await?;
        Ok(rows
            .next()
            .await?
            .context("invocation count row missing")?
            .get(0)?)
    }

    pub async fn count_receipts(&self) -> anyhow::Result<i64> {
        let mut rows = self.query("SELECT COUNT(*) as c FROM receipts", ()).await?;
        Ok(rows
            .next()
            .await?
            .context("receipt count row missing")?
            .get(0)?)
    }

    pub async fn find_receipt_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let mut rows = self
            .query(
                r#"
            SELECT r.body_json
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE i.organization_id = ? AND i.idempotency_key = ?
            ORDER BY r.created_at ASC
            LIMIT 1
            "#,
                params![org.to_string(), key],
            )
            .await?;
        Ok(match rows.next().await? {
            Some(r) => {
                let body: String = r.get(0)?;
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
        let mut rows = self
            .query(
                "SELECT body_json FROM intents WHERE organization_id = ? AND idempotency_key = ?",
                params![org.to_string(), key],
            )
            .await?;
        Ok(match rows.next().await? {
            Some(r) => {
                let body: String = r.get(0)?;
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
        self.execute(
            "INSERT INTO encrypted_item_revisions (id, vault_id, item_id, revision, envelope_version, ciphertext, wrapping_json, ad_digest, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
            params![
                uuid::Uuid::now_v7().to_string(),
                vault_id,
                item_id,
                revision,
                ciphertext,
                wrapping_json,
                ad_digest,
                Utc::now().to_rfc3339()
            ],
        )
        .await?;
        self.after_write().await;
        Ok(())
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

fn turso_path(input: &str) -> String {
    if matches!(input, ":memory:" | "sqlite::memory:" | "turso::memory:") {
        return ":memory:".into();
    }
    let path = input
        .strip_prefix("sqlite://")
        .or_else(|| input.strip_prefix("file:"))
        .unwrap_or(input);
    path.split('?').next().unwrap_or(path).to_string()
}

fn ensure_parent(path: &str) -> anyhow::Result<()> {
    if path == ":memory:" {
        return Ok(());
    }
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating Turso database directory {}", parent.display()))?;
    }
    Ok(())
}

/// Embedded migrations are hand-written and contain neither `--` nor `;` inside a
/// string literal, so stripping line comments and splitting on `;` is sufficient and
/// keeps the migrator dependency-free.
fn split_statements(sql: &str) -> Vec<String> {
    let stripped: String = sql
        .lines()
        .map(|line| match line.find("--") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    stripped
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
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

        // A second boot must be a no-op rather than a replay: 0002 drops the
        // connections table, so re-running it would destroy live rows.
        db.migrate().await.unwrap();
        assert_eq!(db.applied_migrations().await.unwrap(), applied);
    }

    #[tokio::test]
    async fn memory_schema_is_shared_by_turso_connections() {
        let db = Db::connect_memory().await.unwrap();
        let first = db.connection().await.unwrap();
        let second = db.connection().await.unwrap();
        let mut first_rows = first
            .query("SELECT COUNT(*) FROM connections", ())
            .await
            .unwrap();
        let mut second_rows = second
            .query("SELECT COUNT(*) FROM connections", ())
            .await
            .unwrap();
        assert_eq!(
            first_rows
                .next()
                .await
                .unwrap()
                .unwrap()
                .get::<i64>(0)
                .unwrap(),
            0
        );
        assert_eq!(
            second_rows
                .next()
                .await
                .unwrap()
                .unwrap()
                .get::<i64>(0)
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn migrating_an_existing_database_records_without_destroying() {
        let db = Db::connect_memory().await.unwrap();
        db.execute(
            "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, shareability, max_invoke_level, egress_json, created_at, updated_at) \
             VALUES ('c1','org:1',NULL,'github','github/main','GitHub','pending',NULL,'[]','[]',NULL,'organization','private',2,'{}','t','t')",
            (),
        )
        .await
        .unwrap();

        db.migrate().await.unwrap();

        let mut rows = db
            .query("SELECT COUNT(*) AS c FROM connections", ())
            .await
            .unwrap();
        assert_eq!(
            rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(),
            1
        );
    }

    #[test]
    fn legacy_sqlite_urls_map_to_turso_paths() {
        assert_eq!(turso_path("sqlite::memory:"), ":memory:");
        assert_eq!(
            turso_path("sqlite:///tmp/opensesame.db?mode=rwc"),
            "/tmp/opensesame.db"
        );
        assert_eq!(
            turso_path(".tools/run/opensesame.db"),
            ".tools/run/opensesame.db"
        );
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
}
