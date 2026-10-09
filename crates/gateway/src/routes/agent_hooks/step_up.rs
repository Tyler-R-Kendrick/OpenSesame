//! The step-up a change to the agent-hooks policy needs (ADR 0159, on ADR
//! 0146's `step_up_required` and ADR 0084's recent-WebAuthn evidence).
//!
//! The policy governs agent loops, and an agent framework often runs under an
//! administrator's own native CLI token. Owner/admin alone would therefore
//! let the governed loop rewrite the rules that govern it. Replacing the
//! policy, and any other setting that decides what an agent may do without a
//! person (the approver), takes one of two things:
//!
//! - **The operator token.** The Host owner's own credential, never minted
//!   into a session and never carried by an agent grant.
//! - **A fresh step-up on a human's native session**: `assurance`
//!   `phishing_resistant`, `amr` exactly `["webauthn"]`, and a
//!   `last_step_up_at` no older than [`STEP_UP_MAX_AGE_SECS`] — the same
//!   evidence `agent_runs` asks before a control handoff.
//!
//! Nothing delegated satisfies it, whatever evidence it carries: an agent
//! capability, a browser grant, and a native session whose ceiling is
//! anything but the plain `host:user` ceiling (it carries agent capabilities,
//! so something is acting for the person) are refused as
//! `delegated_credential`. The refusal is `403`, never `401` (ADR 0146): a
//! caller asked to prove itself has not been signed out.
//!
//! [`require_step_up`] is the one guard; a setting that must not be changed
//! by the loop it governs calls it with the action's name and gets the same
//! answers, codes and hints.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_session, Caller};
use crate::session_claims::{Assurance, CredentialKind, HostSessionClaims};

/// How recent a step-up must be. Matches the window the run-control handoff
/// asks for (`agent_runs`).
pub(crate) const STEP_UP_MAX_AGE_SECS: i64 = 300;

/// The stable code of a refusal for want of a step-up (ADR 0146).
pub(crate) const STEP_UP_REQUIRED: &str = "step_up_required";

/// Why a session's claims are not a step-up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepUpRefusal {
    /// An agent capability, a browser grant or a session with a delegated
    /// ceiling: acting for a person, never the person.
    Delegated,
    /// A native session that has not stepped up.
    Absent,
    /// A step-up older than [`STEP_UP_MAX_AGE_SECS`] (or dated in the future).
    Stale,
}

impl StepUpRefusal {
    /// The `error` member of the refusal: the same stable code for all three,
    /// with `reason` telling them apart.
    const fn reason(self) -> &'static str {
        match self {
            Self::Delegated => "delegated_credential",
            Self::Absent => "no_step_up",
            Self::Stale => "stale_step_up",
        }
    }

    /// The hint names the remedy, never the credential.
    fn hint(self, action: &str) -> String {
        let remedy = "present the operator token (`Authorization: Bearer operator:<token>`, \
                      OPENSESAME_OPERATOR_TOKEN for the CLI), or use a session that carries a \
                      passkey step-up from the last five minutes";
        match self {
            Self::Delegated => {
                format!("a delegated or agent credential can never {action}; {remedy}")
            }
            Self::Absent => {
                format!("to {action} this session needs a step-up it does not have; {remedy}")
            }
            Self::Stale => format!(
                "to {action} the session's step-up must be from the last five minutes; {remedy}"
            ),
        }
    }
}

/// Whether `claims` are a fresh, undelegated step-up at `now`.
///
/// # Errors
///
/// The [`StepUpRefusal`] saying which of the three conditions failed, in the
/// order delegation, absence, staleness: a delegated credential is refused as
/// such however recent the evidence it carries.
pub(crate) fn fresh_step_up(
    claims: &HostSessionClaims,
    now: DateTime<Utc>,
) -> Result<(), StepUpRefusal> {
    if claims.credential_kind != CredentialKind::NativeSession
        || claims.capability_ceiling.is_empty()
        || claims
            .capability_ceiling
            .iter()
            .any(|cap| cap != "host:user")
    {
        return Err(StepUpRefusal::Delegated);
    }
    let evidence = claims.assurance == Assurance::PhishingResistant && claims.amr == ["webauthn"];
    let Some(at) = claims.last_step_up_at.filter(|_| evidence) else {
        return Err(StepUpRefusal::Absent);
    };
    if at > now || now - at > Duration::seconds(STEP_UP_MAX_AGE_SECS) {
        return Err(StepUpRefusal::Stale);
    }
    Ok(())
}

fn refusal(why: StepUpRefusal, action: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": STEP_UP_REQUIRED,
            "reason": why.reason(),
            "hint": why.hint(action),
        })),
    )
        .into_response()
}

/// The guard: the operator, or the session behind `who` carrying a fresh
/// step-up. `action` completes "to …" in the hint (`replace the agent-hooks
/// policy`).
///
/// `who` is the caller the route already resolved from `headers`; the claims
/// are read again from the same headers, so a request cannot be judged as one
/// credential and authorized as another.
///
/// # Errors
///
/// A `403` `step_up_required` response, with `reason` and a `hint` naming the
/// remedy.
#[allow(clippy::result_large_err)] // axum::Response is intentionally the Err payload
pub(crate) fn require_step_up(
    st: &AppState,
    headers: &HeaderMap,
    who: &Caller,
    action: &str,
) -> Result<(), Response> {
    match who {
        Caller::Operator => Ok(()),
        Caller::Session { .. } => {
            let Ok((_, claims)) = require_session(st, headers) else {
                return Err(refusal(StepUpRefusal::Absent, action));
            };
            fresh_step_up(&claims, Utc::now()).map_err(|why| refusal(why, action))
        }
    }
}
