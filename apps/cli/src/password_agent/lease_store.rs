//! Durable local authority, with `SQLite` immediate transactions for atomic use claims.
use opensesame_connector_host::password_agent::{
    lease::{Lease, Resource},
    request::Binding,
};
use sqlx::{Connection, Row, SqliteConnection};
use std::fs::OpenOptions;
pub(super) struct Store {
    connection: SqliteConnection,
    principal: String,
}
impl Store {
    pub(super) async fn open() -> anyhow::Result<Self> {
        let root = directories::BaseDirs::new()
            .ok_or_else(|| anyhow::anyhow!("Could not locate lease store"))?
            .config_dir()
            .join("opensesame/password-agent-leases");
        Self::at(root).await
    }
    pub(super) async fn at(root: std::path::PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        anyhow::ensure!(
            !std::fs::symlink_metadata(&root)?.file_type().is_symlink(),
            "Invalid lease store directory"
        );
        let path = root.join("leases.sqlite");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        anyhow::ensure!(
            !std::fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "Invalid lease store file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .busy_timeout(std::time::Duration::from_secs(5));
        let mut connection = SqliteConnection::connect_with(&options).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut connection)
            .await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, state TEXT NOT NULL)")
            .execute(&mut connection)
            .await?;
        sqlx::query("INSERT OR IGNORE INTO meta(key,value) VALUES('principal',?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&mut connection)
            .await?;
        let principal: String = sqlx::query_scalar("SELECT value FROM meta WHERE key='principal'")
            .fetch_one(&mut connection)
            .await?;
        Ok(Self {
            connection,
            principal,
        })
    }
    async fn load(&mut self, id: &str) -> anyhow::Result<Lease> {
        let row = sqlx::query("SELECT state FROM leases WHERE id=?")
            .bind(id)
            .fetch_optional(&mut self.connection)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Lease not found"))?;
        let lease: Lease = serde_json::from_str(row.try_get::<&str, _>("state")?)
            .map_err(|_| anyhow::anyhow!("Invalid lease state"))?;
        lease.validate(chrono::Utc::now().timestamp_millis())?;
        Ok(lease)
    }
    pub(super) async fn status(&mut self, id: &str) -> anyhow::Result<Lease> {
        let lease = self.load(id).await?;
        anyhow::ensure!(
            lease.principal == self.principal,
            "Lease principal mismatch"
        );
        Ok(lease)
    }
    pub(super) async fn authorize(&mut self, id: &str, binding: &Binding) -> anyhow::Result<()> {
        self.load(id).await?.authorize(
            &self.principal,
            binding,
            None,
            chrono::Utc::now().timestamp_millis(),
        )
    }
    pub(super) async fn grant(
        &mut self,
        binding: Binding,
        resource: Resource,
        ttl: i64,
        uses: u32,
    ) -> anyhow::Result<Lease> {
        anyhow::ensure!(
            (1..=3600).contains(&ttl) && (1..=10).contains(&uses),
            "Invalid lease grant"
        );
        binding.validate_private_url()?;
        let now = chrono::Utc::now().timestamp_millis();
        let lease = Lease {
            id: uuid::Uuid::new_v4().to_string(),
            principal: self.principal.clone(),
            binding,
            resource,
            created_at: now,
            expires_at: now + ttl * 1000,
            use_budget: uses,
            uses_remaining: uses,
            revoked: false,
        };
        lease.validate(now)?;
        sqlx::query("INSERT INTO leases(id,state) VALUES(?,?)")
            .bind(&lease.id)
            .bind(serde_json::to_string(&lease)?)
            .execute(&mut self.connection)
            .await?;
        let persisted = self.status(&lease.id).await?;
        anyhow::ensure!(
            serde_json::to_value(&persisted)? == serde_json::to_value(&lease)?,
            "Lease creation readback is unverified; inspect before retrying"
        );
        Ok(persisted)
    }
    pub(super) async fn claim(
        &mut self,
        id: &str,
        binding: &Binding,
        resource: &Resource,
    ) -> anyhow::Result<Lease> {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut self.connection)
            .await?;
        let result = async {
            let mut lease = self.load(id).await?;
            lease.authorize(
                &self.principal,
                binding,
                Some(resource),
                chrono::Utc::now().timestamp_millis(),
            )?;
            lease.uses_remaining -= 1;
            sqlx::query("UPDATE leases SET state=? WHERE id=?")
                .bind(serde_json::to_string(&lease)?)
                .bind(id)
                .execute(&mut self.connection)
                .await?;
            Ok::<_, anyhow::Error>(lease)
        }
        .await;
        match result {
            Ok(lease) => {
                sqlx::query("COMMIT").execute(&mut self.connection).await?;
                Ok(lease)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut self.connection).await;
                Err(error)
            }
        }
    }
    pub(super) async fn revoke(&mut self, id: &str) -> anyhow::Result<Lease> {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut self.connection)
            .await?;
        let result = async {
            let mut lease = self.status(id).await?;
            anyhow::ensure!(!lease.revoked, "Lease already revoked");
            lease.revoked = true;
            sqlx::query("UPDATE leases SET state=? WHERE id=?")
                .bind(serde_json::to_string(&lease)?)
                .bind(id)
                .execute(&mut self.connection)
                .await?;
            Ok::<_, anyhow::Error>(lease)
        }
        .await;
        match result {
            Ok(lease) => {
                sqlx::query("COMMIT").execute(&mut self.connection).await?;
                Ok(lease)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut self.connection).await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn atomic_leases_allow_one_claim_and_enforce_version_revoke_expiry() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::at(root.path().to_path_buf()).await.unwrap();
        let binding = opensesame_connector_host::password_agent::request::describe(
            "https://example.com/private?q=private",
            "op://Vault/Item/token",
            "Authorization",
            "Bearer ",
        )
        .unwrap();
        let resource = Resource {
            id: "a".repeat(26),
            version: 7,
        };
        let granted = store
            .grant(binding.clone(), resource.clone(), 600, 1)
            .await
            .unwrap();
        let stale = Resource {
            id: resource.id.clone(),
            version: 8,
        };
        assert!(store.claim(&granted.id, &binding, &stale).await.is_err());
        assert_eq!(store.status(&granted.id).await.unwrap().uses_remaining, 1);
        let mut first = Store::at(root.path().to_path_buf()).await.unwrap();
        let mut second = Store::at(root.path().to_path_buf()).await.unwrap();
        let (a, b) = tokio::join!(
            first.claim(&granted.id, &binding, &resource),
            second.claim(&granted.id, &binding, &resource)
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(store.status(&granted.id).await.unwrap().uses_remaining, 0);
        let renewed = store
            .grant(binding.clone(), resource, 600, 2)
            .await
            .unwrap();
        assert_eq!(renewed.principal, granted.principal);
        store.revoke(&renewed.id).await.unwrap();
        assert!(store.authorize(&renewed.id, &binding).await.is_err());
        let expired = store
            .grant(
                binding.clone(),
                Resource {
                    id: "a".repeat(26),
                    version: 7,
                },
                1,
                1,
            )
            .await
            .unwrap();
        let mut expired = expired;
        expired.created_at -= 2000;
        expired.expires_at -= 2000;
        sqlx::query("UPDATE leases SET state=? WHERE id=?")
            .bind(serde_json::to_string(&expired).unwrap())
            .bind(&expired.id)
            .execute(&mut store.connection)
            .await
            .unwrap();
        assert!(store.authorize(&expired.id, &binding).await.is_err());
    }
}
