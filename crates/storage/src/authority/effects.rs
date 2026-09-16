//! Provider effects: desired authorization and observed enforcement, kept apart.
//!
//! What the authority decided and what a provider actually did are two facts, and
//! collapsing them is how a system comes to claim access was removed because a
//! request returned 200. So `desired_state` carries its own generation, written
//! by the authority, and `observed_state` carries the generation the observation
//! was made against.
//!
//! That is also the fencing rule. An observation may only be recorded against the
//! generation it observed: a webhook delayed behind a newer revoke arrives with an
//! older generation and is refused, rather than reporting a credential active that
//! the authority has already withdrawn. `unknown` is a state, not an absence, and
//! it never reads as removed.

use crate::{append_outbox_tx, Db, Row, Utc};

/// A desired provider effect for one authority.
pub struct DesiredEffect<'a> {
    pub id: &'a str,
    pub organization_id: &'a str,
    pub grant_id: &'a str,
    pub provider_kind: &'a str,
    pub manifest_digest: &'a str,
    /// `present` or `absent`.
    pub desired_state: &'a str,
    pub idempotency_key: &'a str,
}

/// An authenticated observation of what a provider did.
pub struct EffectObservation<'a> {
    pub id: &'a str,
    pub organization_id: &'a str,
    /// The generation this observation was made against. An observation carrying
    /// an older generation is stale by definition.
    pub observed_generation: i64,
    pub observed_state: &'a str,
    pub external_handle: Option<&'a str>,
    pub evidence_digest: Option<&'a str>,
}

impl Db {
    /// Declare or re-declare a desired effect, advancing its generation.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn set_desired_effect(&self, effect: &DesiredEffect<'_>) -> anyhow::Result<i64> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        sqlx::query(
            "INSERT INTO authority_provider_effects \
             (id, organization_id, grant_id, provider_kind, manifest_digest, desired_state, \
              desired_generation, observed_state, observed_generation, idempotency_key, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, 1, 'not_applied', 0, ?, ?) \
             ON CONFLICT (id) DO UPDATE SET desired_state = excluded.desired_state, \
               desired_generation = authority_provider_effects.desired_generation + 1, \
               manifest_digest = excluded.manifest_digest, updated_at = excluded.updated_at",
        )
        .bind(effect.id)
        .bind(effect.organization_id)
        .bind(effect.grant_id)
        .bind(effect.provider_kind)
        .bind(effect.manifest_digest)
        .bind(effect.desired_state)
        .bind(effect.idempotency_key)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query(
            "SELECT desired_generation FROM authority_provider_effects \
             WHERE id = ? AND organization_id = ?",
        )
        .bind(effect.id)
        .bind(effect.organization_id)
        .fetch_one(&mut *tx)
        .await?;
        let generation: i64 = row.try_get("desired_generation")?;
        append_outbox_tx(
            &mut tx,
            "authority.effect.desired",
            &serde_json::json!({
                "organization_id": effect.organization_id,
                "effect_id": effect.id,
                "grant_id": effect.grant_id,
                "desired_state": effect.desired_state,
                "desired_generation": generation,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(generation)
    }

    /// Record an observation, refusing one that is behind the desired state or
    /// behind an observation already recorded.
    ///
    /// # Errors
    ///
    /// Returns an error when the update cannot be written.
    pub async fn observe_effect(
        &self,
        observation: &EffectObservation<'_>,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let changed = sqlx::query(
            "UPDATE authority_provider_effects \
             SET observed_state = ?, observed_generation = ?, observed_at = ?, \
                 external_handle = COALESCE(?, external_handle), \
                 evidence_digest = COALESCE(?, evidence_digest), updated_at = ? \
             WHERE id = ? AND organization_id = ? \
               AND ? = desired_generation AND ? > observed_generation",
        )
        .bind(observation.observed_state)
        .bind(observation.observed_generation)
        .bind(&now)
        .bind(observation.external_handle)
        .bind(observation.evidence_digest)
        .bind(&now)
        .bind(observation.id)
        .bind(observation.organization_id)
        .bind(observation.observed_generation)
        .bind(observation.observed_generation)
        .execute(self.pool())
        .await?
        .rows_affected();
        Ok(changed == 1)
    }

    /// Read one effect's desired and observed state.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row cannot be decoded.
    pub async fn provider_effect(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<(String, i64, String, i64)>> {
        let row = sqlx::query(
            "SELECT desired_state, desired_generation, observed_state, observed_generation \
             FROM authority_provider_effects WHERE id = ? AND organization_id = ?",
        )
        .bind(id)
        .bind(organization_id)
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| {
            Ok((
                row.try_get("desired_state")?,
                row.try_get("desired_generation")?,
                row.try_get("observed_state")?,
                row.try_get("observed_generation")?,
            ))
        })
        .transpose()
    }
}
