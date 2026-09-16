//! The budget ledger: reserve, settle, release — atomically, and idempotently.
//!
//! Capacity is conserved by the database, not by a service remembering to check.
//! `authority_budgets` carries the specification's inequality as a table CHECK:
//!
//! ```text
//! settled_usage + outstanding_reservations <= authorized_capacity
//! ```
//!
//! Every reservation write repeats that inequality in its `WHERE` clause so a
//! loser gets a clean `Refused` instead of an error, and the CHECK stands behind
//! them so a future writer that forgets cannot oversell one root budget to a
//! hundred children.
//!
//! Two behaviours are deliberate and not bugs:
//!
//! * a duplicate idempotency key answers with the reservation that already
//!   exists rather than reserving a second time, so a retry, a redelivered event
//!   and a restart cannot multiply capacity;
//! * an unknown provider outcome settles rather than releases. Work that may
//!   have happened stays charged; only an outcome known not to have consumed
//!   anything is released.

use super::operational_generation_tx;
use crate::{append_outbox_tx, Db, Row, Utc};

/// A budget's key. The scope and the unit are part of it, so a child cannot open
/// a fresh ledger to escape its parent's cap, and a new session cannot reset a
/// daily total by choosing a different window.
pub struct BudgetScope<'a> {
    pub organization_id: &'a str,
    pub scope_kind: &'a str,
    pub scope_id: &'a str,
    pub unit: &'a str,
    pub window_key: &'a str,
}

/// A reservation request.
pub struct Reservation<'a> {
    pub scope: BudgetScope<'a>,
    pub grant_id: &'a str,
    pub quantity: i64,
    pub idempotency_key: &'a str,
}

/// What a reservation attempt did.
#[derive(Debug, PartialEq, Eq)]
pub enum ReserveOutcome {
    /// Capacity was held under this id.
    Accepted { id: String },
    /// This idempotency key already holds capacity; nothing new was reserved.
    Duplicate { id: String },
    /// Capacity, the budget row, or the grant's fence refused it.
    Refused,
}

/// What a settle or release attempt did.
#[derive(Debug, PartialEq, Eq)]
pub enum SettleOutcome {
    /// The reservation moved out of `reserved`.
    Applied,
    /// It was already settled, released or voided; the ledger is unchanged.
    AlreadyFinal,
    /// No such reservation in this realm.
    Unknown,
}

impl Db {
    /// Declare or re-declare a budget's authorized capacity.
    ///
    /// Lowering capacity below what is already settled and outstanding is
    /// refused: the ledger would then describe spending that its own CHECK says
    /// cannot exist.
    ///
    /// # Errors
    ///
    /// Returns an error when the upsert cannot be written.
    pub async fn set_authority_budget(
        &self,
        scope: &BudgetScope<'_>,
        authorized_capacity: i64,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(authorized_capacity >= 0, "capacity cannot be negative");
        let now = Utc::now().to_rfc3339();
        let inserted = sqlx::query(
            "INSERT INTO authority_budgets \
             (organization_id, scope_kind, scope_id, unit, window_key, authorized_capacity, \
              revision, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, 1, ?) \
             ON CONFLICT (organization_id, scope_kind, scope_id, unit, window_key) DO NOTHING",
        )
        .bind(scope.organization_id)
        .bind(scope.scope_kind)
        .bind(scope.scope_id)
        .bind(scope.unit)
        .bind(scope.window_key)
        .bind(authorized_capacity)
        .bind(&now)
        .execute(self.pool())
        .await?
        .rows_affected();
        if inserted == 1 {
            return Ok(true);
        }
        let changed = sqlx::query(
            "UPDATE authority_budgets \
             SET authorized_capacity = ?, revision = revision + 1, updated_at = ? \
             WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND unit = ? \
               AND window_key = ? \
               AND settled_usage + outstanding_reservations <= ? \
               AND allocated_child_capacity <= ?",
        )
        .bind(authorized_capacity)
        .bind(&now)
        .bind(scope.organization_id)
        .bind(scope.scope_kind)
        .bind(scope.scope_id)
        .bind(scope.unit)
        .bind(scope.window_key)
        .bind(authorized_capacity)
        .bind(authorized_capacity)
        .execute(self.pool())
        .await?
        .rows_affected();
        Ok(changed == 1)
    }

    /// Hold capacity for one operation.
    ///
    /// # Errors
    ///
    /// Returns an error when the quantity is not positive or the transaction
    /// cannot be completed.
    pub async fn reserve_authority_budget(
        &self,
        request: &Reservation<'_>,
    ) -> anyhow::Result<ReserveOutcome> {
        anyhow::ensure!(request.quantity > 0, "a reservation must be positive");
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        if let Some(existing) = existing_reservation(
            &mut tx,
            request.scope.organization_id,
            request.idempotency_key,
        )
        .await?
        {
            return Ok(ReserveOutcome::Duplicate { id: existing });
        }
        let operational = operational_generation_tx(&mut tx).await?;
        let pinned = sqlx::query(
            "SELECT 1 AS pinned FROM grant_authority \
             WHERE grant_id = ? AND organization_id = ? AND operational_generation = ?",
        )
        .bind(request.grant_id)
        .bind(request.scope.organization_id)
        .bind(operational)
        .fetch_optional(&mut *tx)
        .await?;
        if pinned.is_none() {
            return Ok(ReserveOutcome::Refused);
        }
        let held = sqlx::query(
            "UPDATE authority_budgets \
             SET outstanding_reservations = outstanding_reservations + ?, \
                 revision = revision + 1, updated_at = ? \
             WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND unit = ? \
               AND window_key = ? \
               AND settled_usage + outstanding_reservations + ? <= authorized_capacity",
        )
        .bind(request.quantity)
        .bind(&now)
        .bind(request.scope.organization_id)
        .bind(request.scope.scope_kind)
        .bind(request.scope.scope_id)
        .bind(request.scope.unit)
        .bind(request.scope.window_key)
        .bind(request.quantity)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if held != 1 {
            return Ok(ReserveOutcome::Refused);
        }
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO authority_budget_reservations \
             (id, organization_id, scope_kind, scope_id, unit, window_key, grant_id, quantity, \
              state, idempotency_key, operational_generation, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(request.scope.organization_id)
        .bind(request.scope.scope_kind)
        .bind(request.scope.scope_id)
        .bind(request.scope.unit)
        .bind(request.scope.window_key)
        .bind(request.grant_id)
        .bind(request.quantity)
        .bind(request.idempotency_key)
        .bind(operational)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        append_outbox_tx(
            &mut tx,
            "authority.budget.reserved",
            &serde_json::json!({
                "organization_id": request.scope.organization_id,
                "reservation_id": id,
                "grant_id": request.grant_id,
                "unit": request.scope.unit,
                "quantity": request.quantity,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(ReserveOutcome::Accepted { id })
    }

    /// Charge a reservation, in whole or in part.
    ///
    /// An unknown provider outcome settles the full reserved quantity: the work
    /// may have happened, and a refund on a timeout is how one budget pays for
    /// two operations.
    ///
    /// # Errors
    ///
    /// Returns an error when the settled quantity exceeds the reservation or the
    /// transaction cannot be completed.
    pub async fn settle_authority_reservation(
        &self,
        organization_id: &str,
        idempotency_key: &str,
        settled_quantity: i64,
    ) -> anyhow::Result<SettleOutcome> {
        anyhow::ensure!(settled_quantity >= 0, "settlement cannot be negative");
        self.finalize(FinalizeReservation {
            organization_id,
            idempotency_key,
            state: "settled",
            settled_quantity: Some(settled_quantity),
        })
        .await
    }

    /// Release a reservation whose operation is known not to have consumed
    /// anything.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn release_authority_reservation(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<SettleOutcome> {
        self.finalize(FinalizeReservation {
            organization_id,
            idempotency_key,
            state: "released",
            settled_quantity: None,
        })
        .await
    }

    /// Read a budget's current settled, outstanding and authorized quantities.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row cannot be decoded.
    pub async fn authority_budget_state(
        &self,
        scope: &BudgetScope<'_>,
    ) -> anyhow::Result<Option<(i64, i64, i64)>> {
        let row = sqlx::query(
            "SELECT settled_usage, outstanding_reservations, authorized_capacity \
             FROM authority_budgets \
             WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND unit = ? \
               AND window_key = ?",
        )
        .bind(scope.organization_id)
        .bind(scope.scope_kind)
        .bind(scope.scope_id)
        .bind(scope.unit)
        .bind(scope.window_key)
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| {
            Ok((
                row.try_get("settled_usage")?,
                row.try_get("outstanding_reservations")?,
                row.try_get("authorized_capacity")?,
            ))
        })
        .transpose()
    }

    async fn finalize(&self, request: FinalizeReservation<'_>) -> anyhow::Result<SettleOutcome> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let row = sqlx::query(
            "SELECT id, scope_kind, scope_id, unit, window_key, quantity, state \
             FROM authority_budget_reservations \
             WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(request.organization_id)
        .bind(request.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            return Ok(SettleOutcome::Unknown);
        };
        if row.get::<String, _>("state") != "reserved" {
            return Ok(SettleOutcome::AlreadyFinal);
        }
        let quantity: i64 = row.try_get("quantity")?;
        let settled = request.settled_quantity.unwrap_or(0);
        anyhow::ensure!(settled <= quantity, "cannot settle more than was reserved");
        sqlx::query(
            "UPDATE authority_budget_reservations \
             SET state = ?, settled_quantity = ?, updated_at = ? \
             WHERE id = ? AND state = 'reserved'",
        )
        .bind(request.state)
        .bind(settled)
        .bind(&now)
        .bind(row.get::<String, _>("id"))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE authority_budgets \
             SET outstanding_reservations = outstanding_reservations - ?, \
                 settled_usage = settled_usage + ?, revision = revision + 1, updated_at = ? \
             WHERE organization_id = ? AND scope_kind = ? AND scope_id = ? AND unit = ? \
               AND window_key = ?",
        )
        .bind(quantity)
        .bind(settled)
        .bind(&now)
        .bind(request.organization_id)
        .bind(row.get::<String, _>("scope_kind"))
        .bind(row.get::<String, _>("scope_id"))
        .bind(row.get::<String, _>("unit"))
        .bind(row.get::<String, _>("window_key"))
        .execute(&mut *tx)
        .await?;
        append_outbox_tx(
            &mut tx,
            "authority.budget.finalized",
            &serde_json::json!({
                "organization_id": request.organization_id,
                "state": request.state,
                "settled_quantity": settled,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(SettleOutcome::Applied)
    }
}

struct FinalizeReservation<'a> {
    organization_id: &'a str,
    idempotency_key: &'a str,
    state: &'a str,
    settled_quantity: Option<i64>,
}

async fn existing_reservation(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization_id: &str,
    idempotency_key: &str,
) -> anyhow::Result<Option<String>> {
    let row = sqlx::query(
        "SELECT id FROM authority_budget_reservations \
         WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(organization_id)
    .bind(idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| Ok(row.try_get("id")?)).transpose()
}
