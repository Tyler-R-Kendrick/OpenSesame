//! Hold-before-side-effect on the invoke path (AZ-DISPATCH / AT-REVOKE-QUEUE).
//!
//! Production and drain share [`finish_dispatch`]: live delegation and the
//! grant window are re-checked immediately before the broker side effect.
//! Tests can arm a one-shot hold so a permitted invoke is queued; fixture
//! work is counted only when `execute_invocation` actually runs.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use opensesame_broker::InvokeInput;
use opensesame_domain::OrganizationId;
use serde_json::json;

use super::super::intents_budget::{
    release_authority_budget_hold, settle_authority_budget_hold, AuthorityBudgetHold,
};
use super::{execute_invocation, not_found, ConstrainedHttpInput, ResolvedInvocation};
use crate::app_state::AppState;

/// A permitted invoke parked by the test hold, replayed by [`drain`].
#[cfg(test)]
struct QueuedInvoke {
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<AuthorityBudgetHold>,
    level: u8,
}

#[cfg(test)]
pub(super) fn hold_next_invoke() {
    hold::arm();
}

#[cfg(test)]
pub(super) fn fixture_work() -> u64 {
    hold::fixture_work()
}

pub(super) async fn dispatch_or_hold(
    st: &AppState,
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<AuthorityBudgetHold>,
    level: u8,
) -> Response {
    #[cfg(test)]
    if hold::take() {
        hold::push(QueuedInvoke {
            org,
            resolved,
            invoke_input,
            constrained_http,
            authority_hold,
            level,
        });
        return (
            StatusCode::ACCEPTED,
            Json(json!({"queued": true, "outcome": "held"})),
        )
            .into_response();
    }
    finish_dispatch(
        st,
        org,
        resolved,
        invoke_input,
        constrained_http,
        authority_hold,
        level,
    )
    .await
}

#[cfg(test)]
pub(super) async fn drain(st: &AppState) -> Response {
    let Some(job) = hold::pop() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no_queued_invoke"})),
        )
            .into_response();
    };
    finish_dispatch(
        st,
        job.org,
        job.resolved,
        job.invoke_input,
        job.constrained_http,
        job.authority_hold,
        job.level,
    )
    .await
}

/// Re-check live delegation and the grant window at the side-effect boundary.
async fn reauthorize(
    st: &AppState,
    resolved: &ResolvedInvocation,
    subject: &str,
) -> Result<(), Response> {
    if !resolved.broker_connection {
        return Ok(());
    }
    if let Some(delegation_id) = &resolved.spend_budget {
        let live = st
            .connection_broker
            .find_live_delegation(subject, &resolved.connection_id.to_string())
            .await;
        let Ok(Some(live)) = live else {
            return Err(not_found());
        };
        if live.delegation_id != *delegation_id || live.grant.id != resolved.grant.id {
            return Err(not_found());
        }
    }
    if resolved.grant.assert_active(Utc::now()).is_err() {
        return Err(not_found());
    }
    Ok(())
}

async fn finish_dispatch(
    st: &AppState,
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<AuthorityBudgetHold>,
    level: u8,
) -> Response {
    if let Err(response) = reauthorize(st, &resolved, &invoke_input.subject).await {
        release_authority_budget_hold(st, authority_hold).await;
        return response;
    }
    #[cfg(test)]
    hold::record_side_effect();
    let result = execute_invocation(st, org, &resolved, invoke_input, constrained_http).await;
    settle_authority_budget_hold(st, authority_hold).await;
    match result {
        Ok(receipt) => {
            let mut body = serde_json::to_value(&receipt).unwrap_or(json!({}));
            if let Some(obj) = body.as_object_mut() {
                if let Some(connection_ref) = &st.connection_ref {
                    obj.insert("connection_ref".into(), json!(connection_ref.handle.uri()));
                }
                obj.insert("invoke_level".into(), json!(level));
                obj.insert("credential_bytes_returned".into(), json!(false));
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(error) => {
            let msg = opensesame_redaction::redact_text(&error.to_string());
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": msg, "type": "about:blank"})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod hold {
    use super::QueuedInvoke;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static HOLD: Cell<bool> = const { Cell::new(false) };
        static QUEUE: RefCell<Vec<QueuedInvoke>> = const { RefCell::new(Vec::new()) };
        static FIXTURE_WORK: Cell<u64> = const { Cell::new(0) };
    }

    pub fn arm() {
        HOLD.with(|flag| flag.set(true));
        QUEUE.with(|queue| queue.borrow_mut().clear());
        FIXTURE_WORK.with(|count| count.set(0));
    }

    pub fn take() -> bool {
        HOLD.with(|flag| flag.replace(false))
    }

    pub fn push(job: QueuedInvoke) {
        QUEUE.with(|queue| queue.borrow_mut().push(job));
    }

    pub fn pop() -> Option<QueuedInvoke> {
        QUEUE.with(|queue| queue.borrow_mut().pop())
    }

    pub fn record_side_effect() {
        FIXTURE_WORK.with(|count| count.set(count.get() + 1));
    }

    pub fn fixture_work() -> u64 {
        FIXTURE_WORK.with(Cell::get)
    }
}
