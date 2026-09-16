//! Restore and failover: the generation that a backup cannot roll back.
//!
//! Restoring a database file moves every row in it back in time. Grants that had
//! been revoked are live again, reservations that had been released are held
//! again, approvals that had been spent are unspent. Nothing inside the file can
//! notice, because the notice would have been restored too.
//!
//! So the fence is two facts held *outside* the file — a `database_identity` and
//! a `generation` — and one rule: an operator who restores must advance the
//! generation before the database serves authority again. Everything issued
//! under an older generation is refused by the fenced read, without a sweep and
//! without trusting a timestamp. `assert_operational_generation` is how a caller
//! that holds the outside witness (a sealed record, a keyring entry, an operator
//! runbook value) refuses to serve a file that is behind it, or a different file
//! altogether.

use super::bump_generation_tx;
use crate::{append_outbox_tx, Db, Row, Utc};

/// The database's own account of which operational generation it is serving.
#[derive(Debug, PartialEq, Eq)]
pub struct OperationalGeneration {
    pub generation: i64,
    pub database_identity: String,
    pub restored_at: Option<String>,
}

/// What an outside observer recorded the last time it saw this database. Held in
/// the trust boundary, not in the database it describes — a witness a restore can
/// rewrite is not a witness.
pub struct GenerationWitness<'a> {
    pub database_identity: &'a str,
    pub generation: i64,
}

impl Db {
    /// Read the operational generation this database is serving.
    ///
    /// # Errors
    ///
    /// Returns an error when the singleton row is missing or cannot be decoded.
    pub async fn operational_generation(&self) -> anyhow::Result<OperationalGeneration> {
        let row = sqlx::query(
            "SELECT generation, database_identity, restored_at \
             FROM authority_operational_generation WHERE id = 1",
        )
        .fetch_one(self.pool())
        .await?;
        Ok(OperationalGeneration {
            generation: row.try_get("generation")?,
            database_identity: row.try_get("database_identity")?,
            restored_at: row.try_get("restored_at")?,
        })
    }

    /// Refuse to serve a database that is behind, or beside, what an outside
    /// witness recorded.
    ///
    /// # Errors
    ///
    /// Returns an error when the identity differs — this is a different database
    /// file than the witness described, so nothing in it can be trusted to be the
    /// same authority — or when its generation is behind the witness, which is a
    /// rolled-back snapshot awaiting recovery rotation.
    pub async fn assert_operational_generation(
        &self,
        witness: &GenerationWitness<'_>,
    ) -> anyhow::Result<()> {
        let current = self.operational_generation().await?;
        anyhow::ensure!(
            current.database_identity == witness.database_identity,
            "authority database identity {} does not match the recorded {}",
            current.database_identity,
            witness.database_identity
        );
        anyhow::ensure!(
            current.generation >= witness.generation,
            "authority database is at generation {} behind the recorded {}: \
             restore recovery rotation is required before serving authority",
            current.generation,
            witness.generation
        );
        Ok(())
    }

    /// Advance the operational generation after a restore or a failover.
    ///
    /// This is the recovery ceremony, and it invalidates rather than resurrects:
    ///
    /// * every sidecar pinned to an older generation stops passing the fenced
    ///   read — no rows are visited, so a large tree costs nothing and a missed
    ///   row is not possible;
    /// * every reservation still held is voided and its capacity returned to
    ///   `outstanding_reservations`, so restored spend capacity cannot be held
    ///   twice. Settled usage is left charged: work that happened stays paid for;
    /// * every projection is marked dirty from revision zero, because whatever a
    ///   projection applied described a database state that no longer exists;
    /// * every realm's invalidation generation advances, so a caller that pinned
    ///   a realm generation before the restore is fenced too.
    ///
    /// Returns the new generation.
    ///
    /// # Errors
    ///
    /// Returns an error when the recovery transaction cannot be completed.
    pub async fn advance_recovery_generation(&self, note: &str) -> anyhow::Result<i64> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        sqlx::query(
            "UPDATE authority_operational_generation \
             SET generation = generation + 1, restored_at = ?, recovery_note = ? WHERE id = 1",
        )
        .bind(&now)
        .bind(note)
        .execute(&mut *tx)
        .await?;
        let row =
            sqlx::query("SELECT generation FROM authority_operational_generation WHERE id = 1")
                .fetch_one(&mut *tx)
                .await?;
        let generation: i64 = row.try_get("generation")?;
        void_held_reservations(&mut tx, &now).await?;
        sqlx::query(
            "UPDATE authority_projections \
             SET applied_revision = 0, dirty_since = ?, model_id = NULL, \
                 last_error = 'authority database recovered; projection state discarded', \
                 updated_at = ? \
             WHERE applied_revision > 0 OR dirty_since IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let realms = sqlx::query(
            "SELECT DISTINCT organization_id FROM authority_generations \
             WHERE subject_kind = 'realm'",
        )
        .fetch_all(&mut *tx)
        .await?;
        for realm in realms {
            let organization_id: String = realm.try_get("organization_id")?;
            bump_generation_tx(
                &mut tx,
                &organization_id,
                super::REALM,
                &organization_id,
                &now,
            )
            .await?;
        }
        append_outbox_tx(
            &mut tx,
            "authority.recovery.generation_advanced",
            &serde_json::json!({"generation": generation, "note": note}).to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(generation)
    }
}

/// Void what was held, not what was spent. A reservation is a claim on capacity
/// whose operation nobody can now account for, so the claim is dropped and the
/// capacity returned; `settled_usage` is untouched, because usage that was
/// charged before the restore was charged for work that really happened.
async fn void_held_reservations(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    now: &str,
) -> anyhow::Result<()> {
    let held = sqlx::query(
        "SELECT id, organization_id, scope_kind, scope_id, unit, window_key, quantity \
         FROM authority_budget_reservations WHERE state = 'reserved'",
    )
    .fetch_all(&mut **tx)
    .await?;
    for row in held {
        let id: String = row.try_get("id")?;
        let quantity: i64 = row.try_get("quantity")?;
        sqlx::query(
            "UPDATE authority_budget_reservations SET state = 'void', updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(&id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE authority_budgets \
             SET outstanding_reservations = MAX(0, outstanding_reservations - ?), \
                 revision = revision + 1, updated_at = ? \
             WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND unit = ? \
               AND window_key = ?",
        )
        .bind(quantity)
        .bind(now)
        .bind(row.get::<String, _>("organization_id"))
        .bind(row.get::<String, _>("scope_kind"))
        .bind(row.get::<String, _>("scope_id"))
        .bind(row.get::<String, _>("unit"))
        .bind(row.get::<String, _>("window_key"))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
