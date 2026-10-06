use super::{
    aliases::retire_row, load_registry, parse_time, save_registry, ControlledReferenceDecision,
};
use crate::{ConnectionId, Db, OrganizationId};
use anyhow::{bail, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use opensesame_human_vault::credential_canaries::{
    decode_presented_id, digest, parse_reference, ArtifactContext, ArtifactKind, Phase, Registry,
};
use sqlx::{Row, Sqlite, Transaction};
use tokio::sync::Semaphore;
static DETECTION_BUDGET: Semaphore = Semaphore::const_new(4);
impl Db {
    /// Resolve only server-enrolled contexts. Unknown reserved references never fall through.
    /// # Errors
    /// Refuses corrupt state, detector contention or a failed metadata transaction.
    pub async fn classify_controlled_reference(
        &self,
        org: &OrganizationId,
        reference: &str,
    ) -> anyhow::Result<ControlledReferenceDecision> {
        if !reference.starts_with("oscanary:") && !reference.starts_with("osissued:") {
            return Ok(ControlledReferenceDecision::Ordinary);
        }
        let _permit = DETECTION_BUDGET
            .try_acquire()
            .context("Controlled detector capacity exceeded")?;
        let bait = reference.starts_with("oscanary:");
        let presented = if bait {
            match parse_reference(reference) {
                Ok(Some(value)) => value,
                _ => return Ok(ControlledReferenceDecision::Reject),
            }
        } else {
            let Some(value) = reference.strip_prefix("osissued:v1:") else {
                return Ok(ControlledReferenceDecision::Reject);
            };
            if decode_presented_id(value).is_err() {
                return Ok(ControlledReferenceDecision::Reject);
            }
            value
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let decision = if bait {
            classify_bait(&mut tx, org, presented).await?
        } else {
            classify_alias(&mut tx, org, presented).await?
        };
        tx.commit().await?;
        Ok(decision)
    }
}
async fn classify_bait(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    presented: &str,
) -> anyhow::Result<ControlledReferenceDecision> {
    let rows=sqlx::query("SELECT tomb,vault_identity,registry_json FROM host_canary_registries WHERE organization_id=? LIMIT 17").bind(org.to_string()).fetch_all(&mut **tx).await?;
    if rows.len() > 16 {
        bail!("Controlled binding limit exceeded");
    }
    for row in rows {
        let mut registry = Registry::parse(
            &row.get::<String, _>("registry_json"),
            &row.get::<String, _>("tomb"),
            &row.get::<String, _>("vault_identity"),
        )?;
        if let Some(artifact) = registry.probe(presented)? {
            registry.observe_bound(
                &artifact.id,
                presented,
                Phase::Invoked,
                &super::timestamp(Utc::now()),
            )?;
            save_registry(tx, org, &registry).await?;
            break;
        }
    }
    Ok(ControlledReferenceDecision::Reject)
}
async fn classify_alias(
    tx: &mut Transaction<'_, Sqlite>,
    org: &OrganizationId,
    presented: &str,
) -> anyhow::Result<ControlledReferenceDecision> {
    let rows =
        sqlx::query("SELECT * FROM host_controlled_aliases WHERE organization_id=? LIMIT 257")
            .bind(org.to_string())
            .fetch_all(&mut **tx)
            .await?;
    if rows.len() > 256 {
        bail!("Controlled issuer ledger limit exceeded");
    }
    for row in rows {
        let context = ArtifactContext {
            vault_identity: row.get("vault_identity"),
            kind: ArtifactKind::ConnectionRef,
            generation: u32::try_from(row.get::<i64, _>("generation"))?,
        };
        if STANDARD.encode(digest(&context, presented)?) != row.get::<String, _>("digest_b64") {
            continue;
        }
        let mut registry = load_registry(tx, org, &row.get::<String, _>("tomb")).await?;
        if context.vault_identity != registry.vault_identity {
            bail!("Issued generation identity mismatch");
        }
        let now = Utc::now();
        let target_active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connections WHERE id=? AND organization_id=? AND status='active')").bind(row.get::<String,_>("target_connection_id")).bind(org.to_string()).fetch_one(&mut **tx).await?;
        if !target_active
            || row.get::<Option<String>, _>("retired_at").is_some()
            || parse_time(&row.get::<String, _>("expires_at"))? <= now
        {
            let artifact = retire_row(tx, org, &mut registry, &row, &super::timestamp(now)).await?;
            registry.observe_bound(
                &artifact.id,
                presented,
                Phase::RetiredGenerationObserved,
                &super::timestamp(now),
            )?;
            save_registry(tx, org, &registry).await?;
            return Ok(ControlledReferenceDecision::Reject);
        }
        return Ok(ControlledReferenceDecision::ActiveAlias {
            connection_id: ConnectionId::parse(&row.get::<String, _>("target_connection_id"))?,
            target_reference: row.get("target_connection_id"),
        });
    }
    Ok(ControlledReferenceDecision::Reject)
}
