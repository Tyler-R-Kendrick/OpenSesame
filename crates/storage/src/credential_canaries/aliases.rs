use super::{active_count, load_registry, parse_time, save_registry};
use crate::{ConnectionId, Db, OrganizationId};
use anyhow::{bail, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use opensesame_human_vault::credential_canaries::{
    digest, mint_presented_id, Artifact, ArtifactContext, ArtifactKind, ArtifactState, Registry,
};
use serde::Serialize;
use sqlx::{Row, Sqlite, Transaction};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedControlledAlias {
    pub issuer_record_ref: String,
    pub reference: String,
    pub context: ArtifactContext,
    pub expires_at: String,
}
impl Db {
    /// Minting does not grant authority: the resolver still applies the original connection policy.
    /// # Errors
    /// Refuses ambiguous or inactive targets, expiry, capacity, invalid bindings and storage failures.
    pub async fn issue_controlled_alias(
        &self,
        org: &OrganizationId,
        tomb: &str,
        target: &ConnectionId,
        expires_at: &str,
    ) -> anyhow::Result<IssuedControlledAlias> {
        let expiry = parse_time(expires_at)?;
        let now = Utc::now();
        if expiry <= now || expiry > now + Duration::days(1) {
            bail!("Alias expiry must be within 24 hours");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let registry = load_registry(&mut tx, org, tomb).await?;
        let targets:Vec<String>=sqlx::query_scalar("SELECT id FROM connections WHERE (id=? OR id=?) AND organization_id=? AND status='active'")
        .bind(target.to_string()).bind(target.as_uuid().to_string()).bind(org.to_string()).fetch_all(&mut *tx).await?;
        if targets.len() != 1
            || registry.artifacts.len() + active_count(&mut tx, org, tomb).await? >= 16
        {
            bail!("Alias target or capacity refused");
        }
        let next: i64 = sqlx::query_scalar(
            "SELECT next_generation FROM host_canary_registries WHERE organization_id=? AND tomb=?",
        )
        .bind(org.to_string())
        .bind(tomb)
        .fetch_one(&mut *tx)
        .await?;
        let generation = u32::try_from(next)?;
        sqlx::query("UPDATE host_canary_registries SET next_generation=next_generation+1 WHERE organization_id=? AND tomb=?").bind(org.to_string()).bind(tomb).execute(&mut *tx).await?;
        let context = ArtifactContext {
            vault_identity: registry.vault_identity,
            kind: ArtifactKind::ConnectionRef,
            generation,
        };
        let presented = mint_presented_id();
        let fingerprint = STANDARD.encode(digest(&context, &presented)?);
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO host_controlled_aliases(id,organization_id,tomb,vault_identity,target_connection_id,generation,digest_b64,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(&id).bind(org.to_string()).bind(tomb).bind(&context.vault_identity).bind(targets.first().context("Alias target disappeared")?).bind(i64::from(generation)).bind(fingerprint).bind(super::timestamp(now)).bind(expires_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(IssuedControlledAlias {
            issuer_record_ref: id,
            reference: format!("osissued:v1:{presented}"),
            context,
            expires_at: expires_at.into(),
        })
    }
    /// Atomically revoke real alias authority and enroll its already-issued generation for detection.
    /// # Errors
    /// Refuses unknown issuer records, corrupted state or a failed atomic retirement.
    pub async fn retire_controlled_alias(
        &self,
        org: &OrganizationId,
        issuer_record_ref: &str,
    ) -> anyhow::Result<Artifact> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row =
            sqlx::query("SELECT * FROM host_controlled_aliases WHERE id=? AND organization_id=?")
                .bind(issuer_record_ref)
                .bind(org.to_string())
                .fetch_optional(&mut *tx)
                .await?
                .context("Unknown issued credential reference")?;
        let mut registry = load_registry(&mut tx, org, &row.get::<String, _>("tomb")).await?;
        let artifact = retire_row(
            &mut tx,
            org,
            &mut registry,
            &row,
            &super::timestamp(Utc::now()),
        )
        .await?;
        tx.commit().await?;
        Ok(artifact)
    }
}
pub(super) async fn retire_row(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    registry: &mut Registry,
    row: &sqlx::sqlite::SqliteRow,
    at: &str,
) -> anyhow::Result<Artifact> {
    let id: String = row.get("id");
    let context = ArtifactContext {
        vault_identity: row.get("vault_identity"),
        kind: ArtifactKind::ConnectionRef,
        generation: u32::try_from(row.get::<i64, _>("generation"))?,
    };
    let artifact = Artifact {
        id: id.clone(),
        context,
        digest_b64: row.get("digest_b64"),
        state: ArtifactState::Retired,
        created_at: row.get("created_at"),
        retired_at: Some(at.into()),
    };
    if let Some(existing) = registry.artifacts.iter().find(|a| a.id == id) {
        if existing.state != ArtifactState::Retired
            || existing.context != artifact.context
            || existing.digest_b64 != artifact.digest_b64
        {
            return Err(
                opensesame_human_vault::credential_canaries::CanaryError::ContextMismatch.into(),
            );
        }
    } else {
        registry.artifacts.push(artifact.clone());
    }
    registry.validate(&registry.tomb, &registry.vault_identity)?;
    sqlx::query("UPDATE host_controlled_aliases SET retired_at=COALESCE(retired_at,?) WHERE id=? AND organization_id=?").bind(at).bind(id).bind(org.to_string()).execute(&mut **tx).await?;
    save_registry(tx, org, registry).await?;
    Ok(artifact)
}

/// Connection revocation calls this inside its existing transaction, before committing authority withdrawal.
/// # Errors
/// Refuses incomplete schema or storage failure; corrupt optional metadata never blocks withdrawal.
pub async fn retire_aliases_for_connection(
    tx: &mut Transaction<'_, Sqlite>,
    target: &str,
) -> anyhow::Result<()> {
    let table_count:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('host_controlled_aliases','host_canary_registries')").fetch_one(&mut **tx).await?;
    if table_count == 0 {
        return Ok(());
    }
    if table_count != 2 {
        bail!("Incomplete controlled detector schema");
    }
    let at = super::timestamp(Utc::now());
    sqlx::query("UPDATE host_controlled_aliases SET retired_at=? WHERE target_connection_id=? AND retired_at IS NULL").bind(&at).bind(target).execute(&mut **tx).await?;
    let rows=sqlx::query("SELECT * FROM host_controlled_aliases WHERE target_connection_id=? AND retired_at=? LIMIT 256").bind(target).bind(&at).fetch_all(&mut **tx).await?;
    for row in rows {
        if let Err(error) = retire_detection_metadata(tx, &row, &at).await {
            if error
                .downcast_ref::<opensesame_human_vault::credential_canaries::CanaryError>()
                .is_none()
            {
                return Err(error);
            }
        }
    }
    Ok(())
}
async fn retire_detection_metadata(
    tx: &mut Transaction<'_, Sqlite>,
    row: &sqlx::sqlite::SqliteRow,
    at: &str,
) -> anyhow::Result<()> {
    let org = OrganizationId::parse(&row.get::<String, _>("organization_id"))
        .map_err(|_| opensesame_human_vault::credential_canaries::CanaryError::ContextMismatch)?;
    let mut registry = load_registry(tx, &org, &row.get::<String, _>("tomb")).await?;
    retire_row(tx, &org, &mut registry, row, at).await?;
    Ok(())
}
