//! Run-grant persistence on the same authority store as leases.
use super::*;

impl Store {
    async fn load_run_grant(&mut self, id: &str) -> anyhow::Result<RunGrant> {
        let row = sqlx::query("SELECT state FROM run_grants WHERE id=?")
            .bind(id)
            .fetch_optional(&mut self.connection)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Run grant not found"))?;
        let grant: RunGrant = serde_json::from_str(row.try_get::<&str, _>("state")?)
            .map_err(|_| anyhow::anyhow!("Invalid run grant state"))?;
        grant.validate(chrono::Utc::now().timestamp_millis())?;
        Ok(grant)
    }
    pub(crate) async fn run_grant_status(&mut self, id: &str) -> anyhow::Result<RunGrant> {
        let grant = self.load_run_grant(id).await?;
        anyhow::ensure!(
            grant.principal == self.principal,
            "Run grant principal mismatch"
        );
        Ok(grant)
    }
    pub(crate) async fn grant_run(
        &mut self,
        binding: RunGrantBinding,
        ttl: i64,
        uses: u32,
    ) -> anyhow::Result<RunGrant> {
        anyhow::ensure!(
            (1..=3600).contains(&ttl) && (1..=10).contains(&uses),
            "Invalid run grant"
        );
        binding.validate()?;
        let now = chrono::Utc::now().timestamp_millis();
        let grant = RunGrant {
            id: uuid::Uuid::new_v4().to_string(),
            principal: self.principal.clone(),
            binding,
            created_at: now,
            expires_at: now + ttl * 1000,
            use_budget: uses,
            uses_remaining: uses,
            revoked: false,
        };
        grant.validate(now)?;
        sqlx::query("INSERT INTO run_grants(id,state) VALUES(?,?)")
            .bind(&grant.id)
            .bind(serde_json::to_string(&grant)?)
            .execute(&mut self.connection)
            .await?;
        let persisted = self.run_grant_status(&grant.id).await?;
        anyhow::ensure!(
            serde_json::to_value(&persisted)? == serde_json::to_value(&grant)?,
            "Run grant creation readback is unverified; inspect before retrying"
        );
        Ok(persisted)
    }
    pub(crate) async fn claim_run(
        &mut self,
        id: &str,
        binding: &RunGrantBinding,
    ) -> anyhow::Result<RunGrant> {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut self.connection)
            .await?;
        let result = async {
            let mut grant = self.load_run_grant(id).await?;
            grant.authorize(
                &self.principal,
                binding,
                chrono::Utc::now().timestamp_millis(),
            )?;
            grant.uses_remaining -= 1;
            sqlx::query("UPDATE run_grants SET state=? WHERE id=?")
                .bind(serde_json::to_string(&grant)?)
                .bind(id)
                .execute(&mut self.connection)
                .await?;
            Ok::<_, anyhow::Error>(grant)
        }
        .await;
        match result {
            Ok(grant) => {
                sqlx::query("COMMIT").execute(&mut self.connection).await?;
                Ok(grant)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut self.connection).await;
                Err(error)
            }
        }
    }
    pub(crate) async fn revoke_run(&mut self, id: &str) -> anyhow::Result<RunGrant> {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut self.connection)
            .await?;
        let result = async {
            let mut grant = self.run_grant_status(id).await?;
            anyhow::ensure!(!grant.revoked, "Run grant already revoked");
            grant.revoked = true;
            sqlx::query("UPDATE run_grants SET state=? WHERE id=?")
                .bind(serde_json::to_string(&grant)?)
                .bind(id)
                .execute(&mut self.connection)
                .await?;
            Ok::<_, anyhow::Error>(grant)
        }
        .await;
        match result {
            Ok(grant) => {
                sqlx::query("COMMIT").execute(&mut self.connection).await?;
                Ok(grant)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut self.connection).await;
                Err(error)
            }
        }
    }
}
