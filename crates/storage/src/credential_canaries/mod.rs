//! Durable detection-only metadata and issuer-generated connection aliases.
mod aliases;
pub use aliases::{retire_aliases_for_connection, IssuedControlledAlias};
mod classify;
#[cfg(test)]
mod tests;
use crate::{ConnectionId, Db, OrganizationId};
use anyhow::bail;
use chrono::{DateTime, Utc};
use opensesame_human_vault::credential_canaries::{Artifact, ArtifactState, Registry};
use serde::Serialize;
use sqlx::{Row, Sqlite, Transaction};

#[derive(Debug, PartialEq, Eq)]
pub enum ControlledReferenceDecision {
    Ordinary,
    Reject,
    ActiveAlias {
        connection_id: ConnectionId,
        target_reference: String,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCanaryBinding {
    pub organization_id: OrganizationId,
    pub tomb: String,
    pub vault_identity: String,
}
pub(super) async fn load_registry(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    tomb: &str,
) -> anyhow::Result<Registry> {
    let row = sqlx::query("SELECT vault_identity, registry_json FROM host_canary_registries WHERE organization_id=? AND tomb=?")
        .bind(org.to_string()).bind(tomb).fetch_optional(&mut **tx).await?.ok_or(opensesame_human_vault::credential_canaries::CanaryError::ContextMismatch)?;
    Registry::parse(
        &row.get::<String, _>("registry_json"),
        tomb,
        &row.get::<String, _>("vault_identity"),
    )
    .map_err(Into::into)
}
pub(super) async fn save_registry(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    registry: &Registry,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE host_canary_registries SET registry_json=? WHERE organization_id=? AND tomb=?",
    )
    .bind(registry.encode()?)
    .bind(org.to_string())
    .bind(&registry.tomb)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
pub(super) async fn active_count(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    tomb: &str,
) -> anyhow::Result<usize> {
    let n:i64=sqlx::query_scalar("SELECT count(*) FROM host_controlled_aliases WHERE organization_id=? AND tomb=? AND retired_at IS NULL")
 .bind(org.to_string()).bind(tomb).fetch_one(&mut **tx).await?;
    usize::try_from(n).map_err(Into::into)
}
impl Db {
    /// Explicit human/operator enrollment establishes the trusted organization/vault binding.
    /// # Errors
    /// Refuses invalid context, identifier collisions, capacity exhaustion or storage failure.
    pub async fn register_controlled_canary(
        &self,
        binding: &HostCanaryBinding,
        artifact: &Artifact,
    ) -> anyhow::Result<()> {
        if artifact.state != ArtifactState::Bait
            || artifact.context.vault_identity != binding.vault_identity
        {
            bail!("Invalid controlled canary enrollment");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let bindings: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM host_canary_registries WHERE organization_id=?",
        )
        .bind(binding.organization_id.to_string())
        .fetch_one(&mut *tx)
        .await?;
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM host_canary_registries WHERE organization_id=? AND tomb=?)").bind(binding.organization_id.to_string()).bind(&binding.tomb).fetch_one(&mut *tx).await?;
        if !exists && bindings >= 16 {
            bail!("Controlled binding limit reached");
        }
        let empty = Registry::new(&binding.tomb, &binding.vault_identity);
        empty.validate(&binding.tomb, &binding.vault_identity)?;
        sqlx::query("INSERT OR IGNORE INTO host_canary_registries(organization_id,tomb,vault_identity,registry_json) VALUES(?,?,?,?)")
            .bind(binding.organization_id.to_string())
            .bind(&binding.tomb)
            .bind(&binding.vault_identity)
            .bind(empty.encode()?)
            .execute(&mut *tx)
            .await?;
        let mut registry = load_registry(&mut tx, &binding.organization_id, &binding.tomb).await?;
        if registry.vault_identity != binding.vault_identity
            || registry.artifacts.len()
                + active_count(&mut tx, &binding.organization_id, &binding.tomb).await?
                >= 16
        {
            bail!("Controlled registry context or capacity refused");
        }
        let issuer_collision: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM host_controlled_aliases WHERE id=?)")
                .bind(&artifact.id)
                .fetch_one(&mut *tx)
                .await?;
        if issuer_collision {
            bail!("Artifact identifier belongs to an issued credential");
        }
        registry.artifacts.push(artifact.clone());
        save_registry(&mut tx, &binding.organization_id, &registry).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Read the bounded trusted registry for a human management surface.
    /// # Errors
    /// Refuses missing or corrupt bindings and storage failures.
    pub async fn controlled_canary_status(
        &self,
        org: &OrganizationId,
        tomb: &str,
    ) -> anyhow::Result<Registry> {
        let mut tx = self.pool.begin().await?;
        let registry = load_registry(&mut tx, org, tomb).await?;
        tx.commit().await?;
        Ok(registry)
    }
    /// Remove one detection record without changing production connection authority.
    /// # Errors
    /// Refuses missing bindings, unknown artifacts or storage failure.
    pub async fn remove_controlled_canary(
        &self,
        org: &OrganizationId,
        tomb: &str,
        id: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut registry = load_registry(&mut tx, org, tomb).await?;
        let len = registry.artifacts.len();
        registry.artifacts.retain(|a| a.id != id);
        if registry.artifacts.len() == len {
            bail!("Unknown controlled artifact");
        }
        sqlx::query("DELETE FROM host_controlled_aliases WHERE id=? AND organization_id=? AND tomb=? AND retired_at IS NOT NULL").bind(id).bind(org.to_string()).bind(tomb).execute(&mut *tx).await?;
        save_registry(&mut tx, org, &registry).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Clear local closed metadata while retaining enrolled detectors.
    /// # Errors
    /// Refuses missing or corrupt bindings and storage failures.
    pub async fn clear_controlled_canary_events(
        &self,
        org: &OrganizationId,
        tomb: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut registry = load_registry(&mut tx, org, tomb).await?;
        registry.events.clear();
        save_registry(&mut tx, org, &registry).await?;
        tx.commit().await?;
        Ok(())
    }
}
pub(super) fn parse_time(value: &str) -> anyhow::Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

pub(super) fn timestamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
