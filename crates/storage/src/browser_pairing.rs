//! Durable origin/key binding. All authority transitions are atomic SQL writes.
use super::{Db, Row};

pub struct NewBrowserPairing<'a> {
    pub id: &'a str,
    pub device_digest: &'a str,
    pub user_code_digest: &'a str,
    pub origin: &'a str,
    pub dpop_jkt: &'a str,
    pub audience: &'a str,
    pub capabilities_json: &'a str,
    pub now: i64,
}

#[derive(Clone)]
pub struct BrowserGrant {
    pub authentication_json: Option<String>,
    pub client_id: String,
    pub origin: String,
    pub dpop_jkt: String,
    pub audience: String,
    pub capabilities_json: String,
    pub principal_id: String,
    pub organization_id: String,
    pub approved_at: i64,
    pub issued_at: i64,
    pub expires_at: i64,
}

fn grant_row(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<BrowserGrant> {
    Ok(BrowserGrant {
        authentication_json: row.try_get("authentication_json")?,
        client_id: row.try_get("id")?,
        origin: row.try_get("origin")?,
        dpop_jkt: row.try_get("dpop_jkt")?,
        audience: row.try_get("audience")?,
        capabilities_json: row.try_get("capabilities_json")?,
        principal_id: row.try_get("principal_id")?,
        organization_id: row.try_get("organization_id")?,
        approved_at: row.try_get("approved_at")?,
        issued_at: row.try_get("issued_at")?,
        expires_at: row.try_get("expires_at")?,
    })
}

impl Db {
    /// # Errors
    /// Only owner-scoped public client metadata is returned; no grant digest.
    pub async fn list_browser_clients(
        &self,
        principal: &str,
        org: &str,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let rows = sqlx::query("SELECT id,origin,audience,capabilities_json,approved_at,revoked_at FROM browser_clients
            WHERE principal_id=? AND organization_id=? ORDER BY approved_at,id LIMIT 64")
            .bind(principal).bind(org).fetch_all(&self.pool).await?;
        rows.iter().map(|row| Ok(serde_json::json!({
            "id":row.try_get::<String,_>("id")?, "origin":row.try_get::<String,_>("origin")?,
            "audience":row.try_get::<String,_>("audience")?,
            "capabilities":serde_json::from_str::<Vec<String>>(&row.try_get::<String,_>("capabilities_json")?)?,
            "approved_at":row.try_get::<i64,_>("approved_at")?, "revoked_at":row.try_get::<Option<i64>,_>("revoked_at")?,
        }))).collect()
    }

    /// # Errors
    /// Native approval inspection reveals only the bound request, not device secrets.
    pub async fn inspect_browser_pairing(
        &self,
        user_digest: &str,
        now: i64,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        let row = sqlx::query(
            "SELECT origin,dpop_jkt,audience,capabilities_json FROM browser_pairings
            WHERE user_code_digest=? AND state='pending' AND expires_at>?",
        )
        .bind(user_digest)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| Ok(serde_json::json!({
            "origin":row.try_get::<String,_>("origin")?, "dpop_jkt":row.try_get::<String,_>("dpop_jkt")?,
            "audience":row.try_get::<String,_>("audience")?,
            "capabilities":serde_json::from_str::<Vec<String>>(&row.try_get::<String,_>("capabilities_json")?)?,
        }))).transpose()
    }

    /// # Errors
    /// Preflight eligibility reads active grants; it does not authorize requests.
    pub async fn active_browser_origin(&self, origin: &str, now: i64) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT 1 FROM browser_clients c JOIN browser_grants g ON g.client_id=c.id
            WHERE c.origin=? AND c.revoked_at IS NULL AND g.expires_at>? LIMIT 1",
        )
        .bind(origin)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    /// # Errors
    /// Database failure refuses admission; active entries are never evicted.
    pub async fn create_browser_pairing(
        &self,
        input: &NewBrowserPairing<'_>,
    ) -> anyhow::Result<bool> {
        sqlx::query("DELETE FROM browser_pairings WHERE expires_at <= ?")
            .bind(input.now)
            .execute(&self.pool)
            .await?;
        let changed = sqlx::query("INSERT INTO browser_pairings
            (id,device_digest,user_code_digest,origin,dpop_jkt,audience,capabilities_json,state,issued_at,expires_at)
            SELECT ?,?,?,?,?,?,?,'pending',?,? WHERE (SELECT COUNT(*) FROM browser_pairings) < 512")
            .bind(input.id).bind(input.device_digest).bind(input.user_code_digest)
            .bind(input.origin).bind(input.dpop_jkt).bind(input.audience).bind(input.capabilities_json)
            .bind(input.now).bind(input.now.checked_add(300).ok_or_else(|| anyhow::anyhow!("clock overflow"))?)
            .execute(&self.pool).await?;
        Ok(changed.rows_affected() == 1)
    }

    /// # Errors
    /// Only one decision can change pending state.
    pub async fn decide_browser_pairing(
        &self,
        code_digest: &str,
        principal: &str,
        org: &str,
        approve: bool,
        now: i64,
    ) -> anyhow::Result<bool> {
        let changed = sqlx::query(
            "UPDATE browser_pairings SET state=?,principal_id=?,organization_id=?,approved_at=?
            WHERE user_code_digest=? AND state='pending' AND expires_at>?",
        )
        .bind(if approve { "approved" } else { "denied" })
        .bind(principal)
        .bind(org)
        .bind(now)
        .bind(code_digest)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(changed.rows_affected() == 1)
    }

    /// Consume approval and create the short-lived grant in one transaction.
    /// # Errors
    /// Storage failure rolls back consumption, never creating partial authority.
    pub async fn consume_browser_pairing(
        &self,
        device: &str,
        origin: &str,
        jkt: &str,
        token_digest: &str,
        now: i64,
    ) -> anyhow::Result<Option<BrowserGrant>> {
        sqlx::query("DELETE FROM browser_grants WHERE expires_at<=?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM browser_clients WHERE NOT EXISTS (SELECT 1 FROM browser_grants WHERE client_id=browser_clients.id)")
            .execute(&self.pool).await?;
        let mut tx = self.pool.begin().await?;
        let Some(row) = sqlx::query(
            "UPDATE browser_pairings SET state='consumed'
            WHERE device_digest=? AND origin=? AND dpop_jkt=? AND state='approved' AND expires_at>?
            RETURNING *,NULL AS authentication_json",
        )
        .bind(device)
        .bind(origin)
        .bind(jkt)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(None);
        };
        let mut grant = grant_row(&row)?;
        grant.issued_at = now;
        grant.expires_at = now
            .checked_add(300)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let inserted = sqlx::query("INSERT INTO browser_clients (id,origin,dpop_jkt,audience,capabilities_json,principal_id,organization_id,approved_at)
            SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM browser_clients)<4096
            AND (SELECT COUNT(*) FROM browser_clients WHERE principal_id=? AND organization_id=? AND revoked_at IS NULL)<64")
            .bind(&grant.client_id).bind(&grant.origin).bind(&grant.dpop_jkt).bind(&grant.audience)
            .bind(&grant.capabilities_json).bind(&grant.principal_id).bind(&grant.organization_id).bind(grant.approved_at)
            .bind(&grant.principal_id).bind(&grant.organization_id)
            .execute(&mut *tx).await?;
        anyhow::ensure!(inserted.rows_affected() == 1, "browser client capacity");
        sqlx::query("INSERT INTO browser_grants (token_digest,client_id,issued_at,expires_at) VALUES (?,?,?,?)")
            .bind(token_digest).bind(&grant.client_id).bind(now).bind(grant.expires_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(grant))
    }

    /// # Errors
    /// Every request checks live revocation and expiry, including after restart.
    pub async fn browser_grant(
        &self,
        token_digest: &str,
        now: i64,
    ) -> anyhow::Result<Option<BrowserGrant>> {
        let row = sqlx::query(
            "SELECT c.*,g.issued_at,g.expires_at FROM browser_clients c JOIN browser_grants g
            ON g.client_id=c.id WHERE g.token_digest=? AND g.expires_at>? AND c.revoked_at IS NULL",
        )
        .bind(token_digest)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(grant_row).transpose()
    }

    /// # Errors
    /// Owner-scoped revocation immediately invalidates every linked grant.
    pub async fn revoke_browser_client(
        &self,
        id: &str,
        principal: &str,
        org: &str,
        now: i64,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let pending = sqlx::query("UPDATE browser_pairings SET state='denied' WHERE id=? AND principal_id=? AND organization_id=? AND state='approved'")
            .bind(id).bind(principal).bind(org).execute(&mut *tx).await?;
        let changed = sqlx::query("UPDATE browser_clients SET revoked_at=? WHERE id=? AND principal_id=? AND organization_id=? AND revoked_at IS NULL")
            .bind(now).bind(id).bind(principal).bind(org).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(changed.rows_affected() == 1 || pending.rows_affected() == 1)
    }

    /// # Errors
    /// Bounded durable replay rejects at capacity instead of forgetting live proofs.
    pub async fn claim_browser_proof(&self, digest: &str, now: i64) -> anyhow::Result<bool> {
        sqlx::query("DELETE FROM browser_proof_replay WHERE expires_at<=?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        let expiry = now
            .checked_add(361)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let changed = sqlx::query("INSERT INTO browser_proof_replay (digest,expires_at)
            SELECT ?,? WHERE (SELECT COUNT(*) FROM browser_proof_replay)<100000 ON CONFLICT DO NOTHING")
            .bind(digest).bind(expiry).execute(&self.pool).await?;
        Ok(changed.rows_affected() == 1)
    }

    /// # Errors
    /// Shared durable budget bounds valid and invalid approval guesses.
    pub async fn admit_browser_pairing_attempt(
        &self,
        bucket: &str,
        now: i64,
    ) -> anyhow::Result<bool> {
        sqlx::query("DELETE FROM browser_pairing_rate WHERE expires_at<=?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        let expiry = now
            .checked_add(60)
            .ok_or_else(|| anyhow::anyhow!("clock overflow"))?;
        let changed = sqlx::query(
            "INSERT INTO browser_pairing_rate (bucket,attempts,expires_at)
            SELECT ?,1,? WHERE (SELECT COUNT(*) FROM browser_pairing_rate)<4096
            ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<10",
        )
        .bind(bucket)
        .bind(expiry)
        .execute(&self.pool)
        .await?;
        Ok(changed.rows_affected() == 1)
    }
}
