//! Invoke-path budget spends: delegation ledger + authority ledger (INV-BUDGET).
//!
//! Kept out of `intents.rs` so that file can ratchet down rather than grow past
//! its recorded max-lines. Delegation spend is the ADR 0044 connection-offer
//! meter; authority spend is the conserved `authority_budgets` ledger that
//! storage already proves under concurrency.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_storage::authority::InvokeBudgetOutcome;
use serde_json::json;

use crate::app_state::AppState;

use super::intents::ResolvedInvocation;

/// Holds taken against `authority_budgets` for this invoke, if any.
pub(super) struct AuthorityBudgetHold {
    organization_id: String,
    keys: Vec<String>,
}

/// Spend both meters after authorization and before execution.
///
/// # Errors
///
/// Returns a 403 response when either ledger refuses the spend.
pub(super) async fn spend_invoke_budgets(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
    idempotency_key: &str,
) -> Result<Option<AuthorityBudgetHold>, Response> {
    let hold = spend_authority_budget(st, organization_id, resolved, idempotency_key).await?;
    if let Err(response) = spend_delegation_budget(st, resolved).await {
        if let Some(hold) = hold.as_ref() {
            let _ = st
                .db
                .release_invoke_budgets(&hold.organization_id, &hold.keys)
                .await;
        }
        return Err(response);
    }
    Ok(hold)
}

/// Settle authority holds after the provider outcome (unknown outcomes charge).
pub(super) async fn settle_authority_budget_hold(st: &AppState, hold: Option<AuthorityBudgetHold>) {
    let Some(hold) = hold else {
        return;
    };
    let _ = st
        .db
        .settle_invoke_budgets(&hold.organization_id, &hold.keys)
        .await;
}

/// Release a hold that never reached the side-effect boundary (AT-REVOKE-QUEUE).
pub(super) async fn release_authority_budget_hold(
    st: &AppState,
    hold: Option<AuthorityBudgetHold>,
) {
    let Some(hold) = hold else {
        return;
    };
    let _ = st
        .db
        .release_invoke_budgets(&hold.organization_id, &hold.keys)
        .await;
}

async fn spend_authority_budget(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
    idempotency_key: &str,
) -> Result<Option<AuthorityBudgetHold>, Response> {
    let grant_id = resolved.grant.id.to_string();
    match st
        .db
        .reserve_invoke_budgets(organization_id, &grant_id, idempotency_key)
        .await
    {
        Ok(InvokeBudgetOutcome::Skipped) => Ok(None),
        Ok(InvokeBudgetOutcome::Reserved { keys }) => Ok(Some(AuthorityBudgetHold {
            organization_id: organization_id.to_string(),
            keys,
        })),
        Ok(InvokeBudgetOutcome::Exhausted) | Err(_) => Err(budget_exhausted()),
    }
}

async fn spend_delegation_budget(
    st: &AppState,
    resolved: &ResolvedInvocation,
) -> Result<(), Response> {
    let Some(delegation_id) = &resolved.spend_budget else {
        return Ok(());
    };
    st.connection_broker
        .spend_delegation_budget(
            delegation_id,
            opensesame_connection_broker::delegation::BUDGET_INVOCATIONS,
        )
        .await
        .map_err(|_| budget_exhausted())
}

fn budget_exhausted() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "budget_exhausted"})),
    )
        .into_response()
}
