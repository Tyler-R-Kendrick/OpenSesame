//! Purpose-bound challenges and atomic control authorization. No raw tokens are stored.
use crate::{Db, ObservationControlUpdate};
use sqlx::Row;

/// Apply verified Identity role evidence inside the caller's authority transaction.
/// The fence is a native revocation floor, not a last-login timestamp: independent
/// purpose-bound assertions may legitimately share one authentication time.
/// # Errors
/// Refuses absent/revoked memberships, stale evidence and malformed roles.
pub async fn narrow_identity_role(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization: &str,
    principal: &str,
    role: &str,
    auth_time: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(role, "owner" | "admin" | "member"),
        "invalid role evidence"
    );
    let changed = sqlx::query("UPDATE config_authorization_roles SET role=CASE
        WHEN role='member' OR ?='member' THEN 'member'
        WHEN role='admin' OR ?='admin' THEN 'admin' ELSE 'owner' END,revision=revision+1
        WHERE organization_id=? AND principal_id=? AND role IN ('owner','admin','member') AND evidence_after<?")
        .bind(role).bind(role).bind(organization).bind(principal).bind(auth_time)
        .execute(&mut **tx).await?.rows_affected();
    anyhow::ensure!(
        changed == 1,
        "Host membership absent, revoked or evidence stale"
    );
    sqlx::query("INSERT INTO outbox_events(id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
        .bind(uuid::Uuid::now_v7().to_string())
        .bind("config.authorization.identity_narrowed")
        .bind(
            serde_json::json!({"organization_id":organization,"principal_id":principal})
                .to_string(),
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Authentication {
    role: String,
    auth_time: i64,
}

pub struct HostAuthorization {
    pub id: String,
    pub client_id: String,
    pub digest: String,
    pub operation: String,
    pub target_id: String,
    pub transition: Option<String>,
    pub run_version: Option<i64>,
    pub expires_at: i64,
}

impl Db {
    /// # Errors
    /// Refuses storage failure and bounded capacity without evicting live requests.
    pub async fn create_host_authorization(
        &self,
        input: &HostAuthorization,
        now: i64,
    ) -> anyhow::Result<bool> {
        sqlx::query("DELETE FROM host_authorizations WHERE expires_at<=?")
            .bind(now)
            .execute(self.pool())
            .await?;
        let result = sqlx::query("INSERT INTO host_authorizations(id,client_id,digest,operation,target_id,transition,run_version,state,expires_at)
            SELECT ?,?,?,?,?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM host_authorizations)<4096
            AND (SELECT COUNT(*) FROM host_authorizations WHERE client_id=?)<8
            AND EXISTS(SELECT 1 FROM browser_clients c JOIN browser_grants g ON g.client_id=c.id
                WHERE c.id=? AND c.revoked_at IS NULL AND g.expires_at>?)")
            .bind(&input.id).bind(&input.client_id).bind(&input.digest).bind(&input.operation)
            .bind(&input.target_id).bind(&input.transition).bind(input.run_version).bind(input.expires_at)
            .bind(&input.client_id).bind(&input.client_id).bind(now).execute(self.pool()).await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    /// Only an active client can inspect its own pending challenge.
    pub async fn host_authorization(
        &self,
        id: &str,
        client: &str,
        now: i64,
    ) -> anyhow::Result<Option<HostAuthorization>> {
        let row = sqlx::query("SELECT h.* FROM host_authorizations h JOIN browser_clients c ON c.id=h.client_id
            WHERE h.id=? AND h.client_id=? AND h.state='pending' AND h.expires_at>? AND c.revoked_at IS NULL")
            .bind(id).bind(client).bind(now).fetch_optional(self.pool()).await?;
        row.map(|row| {
            Ok(HostAuthorization {
                id: row.try_get("id")?,
                client_id: row.try_get("client_id")?,
                digest: row.try_get("digest")?,
                operation: row.try_get("operation")?,
                target_id: row.try_get("target_id")?,
                transition: row.try_get("transition")?,
                run_version: row.try_get("run_version")?,
                expires_at: row.try_get("expires_at")?,
            })
        })
        .transpose()
    }

    /// # Errors
    /// Evidence replay, revocation, or a racing consumer cannot mint authority twice.
    pub async fn authorize_host_challenge(
        &self,
        input: &HostAuthorization,
        evidence_jti: &str,
        authentication_json: Option<&str>,
        elevation_digest: Option<&str>,
        now: i64,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            authentication_json.is_some() != elevation_digest.is_some(),
            "exactly one authorization purpose required"
        );
        let mut tx = self.pool().begin().await?;
        let changed = sqlx::query("UPDATE host_authorizations SET state=?,evidence_jti=?,elevation_digest=?
            WHERE id=? AND client_id=? AND digest=? AND state='pending' AND expires_at>?
            AND EXISTS(SELECT 1 FROM browser_clients c JOIN browser_grants g ON g.client_id=c.id
                WHERE c.id=host_authorizations.client_id AND c.revoked_at IS NULL AND g.expires_at>?)")
            .bind(if authentication_json.is_some() { "consumed" } else { "authorized" })
            .bind(evidence_jti).bind(elevation_digest).bind(&input.id).bind(&input.client_id).bind(&input.digest).bind(now).bind(now)
            .execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        if let Some(authentication) = authentication_json {
            anyhow::ensure!(
                input.operation == "browser.authenticate",
                "wrong authorization purpose"
            );
            let evidence: Authentication = serde_json::from_str(authentication)?;
            let client = sqlx::query("SELECT principal_id,organization_id FROM browser_clients WHERE id=? AND revoked_at IS NULL")
                .bind(&input.client_id).fetch_one(&mut *tx).await?;
            narrow_identity_role(
                &mut tx,
                client.try_get("organization_id")?,
                client.try_get("principal_id")?,
                &evidence.role,
                evidence.auth_time,
            )
            .await?;
            sqlx::query("UPDATE browser_clients SET authentication_json=? WHERE id=? AND revoked_at IS NULL")
                .bind(authentication).bind(&input.client_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE browser_grants SET issued_at=? WHERE client_id=? AND expires_at>?")
                .bind(now)
                .bind(&input.client_id)
                .bind(now)
                .execute(&mut *tx)
                .await?;
        } else {
            anyhow::ensure!(
                input.operation == "agent.browser.control",
                "wrong authorization purpose"
            );
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Consume the exact elevation in the same transaction as the versioned control write.
    /// # Errors
    /// SQL failure rolls back both consumption and effect. A stale run consumes neither.
    pub async fn control_with_host_authorization(
        &self,
        client: &str,
        elevation_digest: &str,
        transition: &str,
        update: &ObservationControlUpdate,
        now: i64,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool().begin().await?;
        let changed = sqlx::query("UPDATE host_authorizations SET state='consumed'
            WHERE client_id=? AND elevation_digest=? AND operation='agent.browser.control'
            AND target_id=? AND transition=? AND run_version=? AND state='authorized' AND expires_at>?
            AND EXISTS(SELECT 1 FROM browser_clients c JOIN browser_grants g ON g.client_id=c.id
                WHERE c.id=host_authorizations.client_id AND c.revoked_at IS NULL AND g.expires_at>?
                AND c.organization_id=? AND EXISTS(SELECT 1 FROM observation_runs r WHERE r.id=host_authorizations.target_id
                    AND r.organization_id=c.organization_id AND r.owner_principal_id=c.principal_id))")
            .bind(client).bind(elevation_digest).bind(&update.run_id).bind(transition).bind(update.expected_version)
            .bind(now).bind(now).bind(&update.organization_id).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        let timestamp = chrono::DateTime::from_timestamp(now, 0)
            .ok_or_else(|| anyhow::anyhow!("invalid time"))?
            .to_rfc3339();
        let changed = sqlx::query(
            "UPDATE observation_runs SET control_state=?,quiescence=?,handoff_queued=?,
            lease_holder=?,lease_expires_at=?,blocked_reason=?,version=version+1,updated_at=?
            WHERE id=? AND organization_id=? AND version=? AND closed_at IS NULL",
        )
        .bind(&update.control_state)
        .bind(&update.quiescence)
        .bind(i64::from(update.handoff_queued))
        .bind(&update.lease_holder)
        .bind(&update.lease_expires_at)
        .bind(&update.blocked_reason)
        .bind(timestamp)
        .bind(&update.run_id)
        .bind(&update.organization_id)
        .bind(update.expected_version)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        tx.commit().await?;
        Ok(true)
    }
}
