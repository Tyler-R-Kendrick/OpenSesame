//! Host invoke spend against `authority_budgets` (INV-BUDGET dispatch path).
//!
//! Storage already conserves capacity under concurrent `reserve_authority_budget`
//! callers. This module is the Host-facing seam: look up every `root_grant`
//! budget scoped to the grant about to run, hold one unit on each, and hand the
//! caller the idempotency keys it must settle or release after the provider
//! outcome is known.
//!
//! No matching budget row is a skip, not a free ride through a missing fence —
//! bootstrap and legacy grants without a ledger stay on their own paths
//! (`spend_delegation_budget`, unmetered demo grants). An existing ledger that
//! cannot admit the hold is exhaustion and must deny the invoke.

use super::budget::{BudgetScope, Reservation, ReserveOutcome, SettleOutcome};
use crate::{Db, Row};

/// What `reserve_invoke_budgets` did for one grant.
#[derive(Debug, PartialEq, Eq)]
pub enum InvokeBudgetOutcome {
    /// No `root_grant` budgets are configured for this grant.
    Skipped,
    /// Capacity is held under these idempotency keys (one per unit/window).
    Reserved { keys: Vec<String> },
    /// At least one configured budget refused the hold.
    Exhausted,
}

impl Db {
    /// Hold one unit on every `root_grant` budget scoped to `grant_id`.
    ///
    /// # Errors
    ///
    /// Returns an error when a reservation transaction cannot be written.
    pub async fn reserve_invoke_budgets(
        &self,
        organization_id: &str,
        grant_id: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<InvokeBudgetOutcome> {
        let rows = sqlx::query(
            "SELECT unit, window_key FROM authority_budgets \
             WHERE organization_id = ? AND scope_kind = 'root_grant' AND scope_id = ? \
             ORDER BY unit, window_key",
        )
        .bind(organization_id)
        .bind(grant_id)
        .fetch_all(self.pool())
        .await?;
        if rows.is_empty() {
            return Ok(InvokeBudgetOutcome::Skipped);
        }
        let mut keys = Vec::with_capacity(rows.len());
        for row in &rows {
            let unit: String = row.get("unit");
            let window_key: String = row.get("window_key");
            let key = format!("{idempotency_key}:{unit}:{window_key}");
            let outcome = self
                .reserve_authority_budget(&Reservation {
                    scope: BudgetScope {
                        organization_id,
                        scope_kind: "root_grant",
                        scope_id: grant_id,
                        unit: &unit,
                        window_key: &window_key,
                    },
                    grant_id,
                    quantity: 1,
                    idempotency_key: &key,
                })
                .await?;
            match outcome {
                ReserveOutcome::Accepted { .. } | ReserveOutcome::Duplicate { .. } => {
                    keys.push(key);
                }
                ReserveOutcome::Refused => {
                    let _ = self.release_invoke_budgets(organization_id, &keys).await;
                    return Ok(InvokeBudgetOutcome::Exhausted);
                }
            }
        }
        Ok(InvokeBudgetOutcome::Reserved { keys })
    }

    /// Charge every held invoke reservation (unknown provider outcomes settle).
    ///
    /// # Errors
    ///
    /// Returns an error when a finalize transaction cannot be written.
    pub async fn settle_invoke_budgets(
        &self,
        organization_id: &str,
        keys: &[String],
    ) -> anyhow::Result<()> {
        for key in keys {
            let _ = self
                .settle_authority_reservation(organization_id, key, 1)
                .await?;
        }
        Ok(())
    }

    /// Release holds when the invoke is known not to have consumed capacity.
    ///
    /// # Errors
    ///
    /// Returns an error when a finalize transaction cannot be written.
    pub async fn release_invoke_budgets(
        &self,
        organization_id: &str,
        keys: &[String],
    ) -> anyhow::Result<()> {
        for key in keys {
            let outcome = self
                .release_authority_reservation(organization_id, key)
                .await?;
            debug_assert!(
                matches!(
                    outcome,
                    SettleOutcome::Applied | SettleOutcome::AlreadyFinal | SettleOutcome::Unknown
                ),
                "release must be a ledger outcome"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::fix_support::{budget_scope, entry, issue, seed_grant, seed_realm};
    use super::InvokeBudgetOutcome;
    use crate::Db;
    use std::sync::Arc;

    #[tokio::test]
    async fn invoke_spend_skips_when_no_budget_is_configured() {
        let db = Db::connect_memory().await.unwrap();
        let (organization_id, _) = seed_realm(&db, "org:skip").await;
        seed_grant(&db, &organization_id, "grant:bare").await;
        let outcome = db
            .reserve_invoke_budgets(&organization_id, "grant:bare", "inv:1")
            .await
            .unwrap();
        assert_eq!(outcome, InvokeBudgetOutcome::Skipped);
    }

    #[tokio::test]
    async fn invoke_spend_conserves_capacity_under_concurrent_dispatch() {
        let db = Db::connect_memory().await.unwrap();
        let (organization_id, domain_id) = seed_realm(&db, "org:dispatch").await;
        seed_grant(&db, &organization_id, "grant:root").await;
        assert!(db
            .issue_authority(
                &issue("grant:root", &organization_id, &domain_id),
                &[entry("fixture:api", "invoke")],
            )
            .await
            .unwrap());
        let scope = budget_scope(&organization_id, "grant:root", "dispatch:day");
        db.set_authority_budget(&scope, 3).await.unwrap();

        let db = Arc::new(db);
        let mut accepted = 0;
        let mut handles = Vec::new();
        for index in 0..12 {
            let db = Arc::clone(&db);
            handles.push(tokio::spawn(async move {
                db.reserve_invoke_budgets("org:dispatch", "grant:root", &format!("inv:{index}"))
                    .await
                    .unwrap()
            }));
        }
        for handle in handles {
            if matches!(handle.await.unwrap(), InvokeBudgetOutcome::Reserved { .. }) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 3);
    }
}
