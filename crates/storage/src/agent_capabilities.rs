//! Explicit operator-approved launch authority, separate from browser grants.
use super::{Db, Row};

pub struct AgentLaunch<'a> {
    pub handle_digest: &'a str,
    pub principal_id: &'a str,
    pub organization_id: &'a str,
    pub client_id: &'a str,
    pub audience: &'a str,
    pub resource: &'a str,
    pub capabilities_json: &'a str,
    pub now: i64,
}

#[derive(Clone)]
pub struct AgentGrant {
    pub principal_id: String,
    pub organization_id: String,
    pub client_id: String,
    pub audience: String,
    pub resource: String,
    pub capabilities_json: String,
    pub approved_at: i64,
    pub issued_at: i64,
    pub expires_at: i64,
}

fn row(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<AgentGrant> {
    Ok(AgentGrant {
        principal_id: row.try_get("principal_id")?,
        organization_id: row.try_get("organization_id")?,
        client_id: row.try_get("client_id")?,
        audience: row.try_get("audience")?,
        resource: row.try_get("resource")?,
        capabilities_json: row.try_get("capabilities_json")?,
        approved_at: row.try_get("approved_at")?,
        issued_at: row.try_get("issued_at")?,
        expires_at: row.try_get("expires_at")?,
    })
}

impl Db {
    /// # Errors
    /// Refuses invalid lifetimes or unavailable durable state.
    pub async fn create_agent_launch(&self, launch: &AgentLaunch<'_>) -> anyhow::Result<bool> {
        let expiry = launch
            .now
            .checked_add(300)
            .ok_or_else(|| anyhow::anyhow!("invalid launch time"))?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM agent_capabilities WHERE expires_at<=?")
            .bind(launch.now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM agent_launches WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM agent_capabilities c WHERE c.launch_digest=agent_launches.handle_digest)").bind(launch.now).execute(&mut *tx).await?;
        let inserted=sqlx::query("INSERT INTO agent_launches(handle_digest,principal_id,organization_id,client_id,audience,resource,capabilities_json,approved_at,expires_at)
            SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM agent_launches)<4096 AND
            (SELECT COUNT(*) FROM agent_launches WHERE principal_id=? AND organization_id=?)<64")
            .bind(launch.handle_digest).bind(launch.principal_id).bind(launch.organization_id).bind(launch.client_id).bind(launch.audience).bind(launch.resource).bind(launch.capabilities_json).bind(launch.now).bind(expiry).bind(launch.principal_id).bind(launch.organization_id).execute(&mut *tx).await?.rows_affected()==1;
        tx.commit().await?;
        Ok(inserted)
    }

    /// # Errors
    /// The durable single-winner transition must succeed before a credential is issued.
    pub async fn exchange_agent_launch(
        &self,
        handle: &str,
        token: &str,
        client: &str,
        audience: &str,
        resource: &str,
        now: i64,
    ) -> anyhow::Result<Option<AgentGrant>> {
        let expiry = now
            .checked_add(300)
            .ok_or_else(|| anyhow::anyhow!("invalid grant time"))?;
        let mut tx = self.pool.begin().await?;
        let claimed=sqlx::query("UPDATE agent_launches SET consumed=1 WHERE handle_digest=? AND client_id=? AND audience=? AND resource=? AND consumed=0 AND revoked=0 AND expires_at>?
            RETURNING principal_id,organization_id,client_id,audience,resource,capabilities_json,approved_at,? AS issued_at,? AS expires_at")
            .bind(handle).bind(client).bind(audience).bind(resource).bind(now).bind(now).bind(expiry).fetch_optional(&mut *tx).await?;
        let Some(claimed) = claimed else {
            tx.rollback().await?;
            return Ok(None);
        };
        sqlx::query("INSERT INTO agent_capabilities(token_digest,launch_digest,issued_at,expires_at) VALUES(?,?,?,?)").bind(token).bind(handle).bind(now).bind(expiry).execute(&mut *tx).await?;
        let grant = row(&claimed)?;
        tx.commit().await?;
        Ok(Some(grant))
    }

    /// # Errors
    /// Unavailable state refuses authorization rather than using cached claims.
    pub async fn agent_grant(&self, token: &str, now: i64) -> anyhow::Result<Option<AgentGrant>> {
        let found=sqlx::query("SELECT l.principal_id,l.organization_id,l.client_id,l.audience,l.resource,l.capabilities_json,l.approved_at,c.issued_at,c.expires_at FROM agent_capabilities c JOIN agent_launches l ON l.handle_digest=c.launch_digest WHERE c.token_digest=? AND c.expires_at>? AND l.revoked=0")
            .bind(token).bind(now).fetch_optional(&self.pool).await?;
        found.as_ref().map(row).transpose()
    }

    /// # Errors
    /// Revocation is principal/org/client scoped and invalidates pending and live grants.
    pub async fn revoke_agent_client(
        &self,
        principal: &str,
        org: &str,
        client: &str,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE agent_launches SET revoked=1 WHERE principal_id=? AND organization_id=? AND client_id=?")
            .bind(principal).bind(org).bind(client).execute(&self.pool).await?;
        Ok(())
    }
}
