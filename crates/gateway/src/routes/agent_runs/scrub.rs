//! What a driver's outcome becomes before it is stored (ADR 0159).
//!
//! The outcome route is the one place a driver's word becomes a queue row, so
//! it is scrubbed here rather than left to whoever reads the row: a step the
//! executor stopped waiting for is never read, and a row stored verbatim is
//! never narrowed by a reader that is not there.
//!
//! Two rules, in this order:
//!
//! 1. **At rest, unconditionally.** Every credential-shaped string (and key) is
//!    replaced by its `[redacted:<kind>]` marker and the outcome is bounded, so
//!    the queue never holds what a driver should not have sent. The shape is
//!    kept — only string values change — so the executor decodes what it would
//!    have decoded.
//! 2. **The organization's guard still decides what the executor may read.** A
//!    policy that would *react* to a credential reaching its interceptor — a
//!    `secret_guard` of `deny`, or a `refuse_labels` naming
//!    `opensesame:credential_material` — never sees one now, because the marker
//!    is not a credential. So under such a policy the outcome is stored as a
//!    refused step (`failed` / `refused`), the same thing a `post_tool_call`
//!    deny does to a result: discarded, and the executor fails closed. A policy
//!    that cannot be read is treated the same way.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_agent_hooks::secrets;
use opensesame_agent_hooks::{HookPolicy, SecretGuard, LABEL_CREDENTIAL_MATERIAL};
use opensesame_domain::OrganizationId;
use serde_json::{json, Value};

use crate::app_state::AppState;

/// Longest outcome, JSON-encoded, the route will store.
///
/// A `StepOutcome` is a verdict on a step plus, at most, a redacted page read
/// or a masked still; nothing an honest driver sends comes near a mebibyte, and
/// a row is read back on every poll of the executor, so the bound is on what a
/// misbehaving driver can make the queue carry.
pub const MAX_OUTCOME_BYTES: usize = 1 << 20;

/// The outcome the executor reads for a refused step: a `StepOutcome::Failed`
/// carrying `StepError::Refused`, which is what a hook verdict's refusal is.
const REFUSED_OUTCOME: &str = r#"{"outcome":"failed","error":"refused"}"#;

/// An outcome the route will not store.
pub(super) enum Unsettleable {
    /// It does not encode as JSON.
    Unencodable,
    /// It is over [`MAX_OUTCOME_BYTES`], before or after redaction.
    TooLarge,
}

impl Unsettleable {
    pub(super) fn response(&self) -> Response {
        let (status, error, hint) = match self {
            Self::Unencodable => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "outcome is not encodable".to_owned(),
            ),
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "outcome_too_large",
                format!("an outcome is at most {MAX_OUTCOME_BYTES} bytes"),
            ),
        };
        (status, Json(json!({"error": error, "hint": hint}))).into_response()
    }
}

/// An outcome as it will be stored.
pub(super) enum Scrubbed {
    /// Nothing credential-shaped: stored as sent.
    Clean(String),
    /// Credential-shaped text replaced by markers.
    Redacted(String),
    /// Credential-shaped text under a policy that refuses it: the step is
    /// stored as refused and the driver's outcome is dropped whole.
    Refused,
}

impl Scrubbed {
    pub(super) fn encoded(&self) -> &str {
        match self {
            Self::Clean(text) | Self::Redacted(text) => text,
            Self::Refused => REFUSED_OUTCOME,
        }
    }

    pub(super) const fn redacted(&self) -> bool {
        !matches!(self, Self::Clean(_))
    }

    pub(super) const fn refused(&self) -> bool {
        matches!(self, Self::Refused)
    }
}

/// Whether the policy reacts to a credential reaching its interceptor, beyond
/// rewriting it: deny it, or refuse later calls once credential material has
/// flowed (`refuse_labels`, on the policy or on any tool rule).
fn reacts_to_credentials(policy: &HookPolicy) -> bool {
    policy.secret_guard == SecretGuard::Deny
        || policy
            .refuse_labels
            .iter()
            .chain(policy.tools.iter().flat_map(|rule| &rule.refuse_labels))
            .any(|label| label == LABEL_CREDENTIAL_MATERIAL)
}

/// Whether the organization's policy has the run refuse credential-shaped
/// outcomes. Unreadable is yes: never decide under a default in its place.
async fn refuses_credentials(st: &AppState, organization_id: &str) -> bool {
    let Ok(organization) = OrganizationId::parse(organization_id) else {
        return true;
    };
    crate::agent_hooks::load_policy(&st.db, &organization)
        .await
        .map_or(true, |loaded| reacts_to_credentials(&loaded.policy))
}

/// The outcome as it will be stored: bounded, and scrubbed as above.
pub(super) async fn scrub(
    st: &AppState,
    organization_id: &str,
    outcome: &Value,
) -> Result<Scrubbed, Unsettleable> {
    let raw = serde_json::to_string(outcome).map_err(|_| Unsettleable::Unencodable)?;
    if raw.len() > MAX_OUTCOME_BYTES {
        return Err(Unsettleable::TooLarge);
    }
    let (clean, findings) = secrets::redact(outcome);
    if findings.is_empty() {
        return Ok(Scrubbed::Clean(raw));
    }
    tracing::warn!(
        found = %findings.summary(),
        "a driver settled credential-shaped text; the outcome is not stored as sent",
    );
    if refuses_credentials(st, organization_id).await {
        return Ok(Scrubbed::Refused);
    }
    let encoded = serde_json::to_string(&clean).map_err(|_| Unsettleable::Unencodable)?;
    if encoded.len() > MAX_OUTCOME_BYTES {
        return Err(Unsettleable::TooLarge);
    }
    Ok(Scrubbed::Redacted(encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(text: &str) -> HookPolicy {
        HookPolicy::parse(text).unwrap()
    }

    #[test]
    fn only_a_policy_that_reacts_to_credentials_refuses_them() {
        assert!(!reacts_to_credentials(&policy(r#"{"version":1}"#)));
        assert!(!reacts_to_credentials(&policy(
            r#"{"version":1,"secret_guard":"off"}"#
        )));
        assert!(reacts_to_credentials(&policy(
            r#"{"version":1,"secret_guard":"deny"}"#
        )));
        assert!(reacts_to_credentials(&policy(&format!(
            r#"{{"version":1,"refuse_labels":["{LABEL_CREDENTIAL_MATERIAL}"]}}"#
        ))));
        assert!(reacts_to_credentials(&policy(&format!(
            r#"{{"version":1,"tools":[{{"name":"deploy","decision":"allow","refuse_labels":["{LABEL_CREDENTIAL_MATERIAL}"]}}]}}"#
        ))));
        assert!(!reacts_to_credentials(&policy(
            r#"{"version":1,"refuse_labels":["acme:pii"]}"#
        )));
    }

    #[test]
    fn the_refused_outcome_is_a_well_formed_failed_step() {
        // The executor decodes what it is handed; a refusal must be one it
        // reads as `StepError::Refused`, not a protocol violation.
        let outcome: opensesame_rotation_web::StepOutcome =
            serde_json::from_str(REFUSED_OUTCOME).unwrap();
        assert_eq!(
            outcome,
            opensesame_rotation_web::StepOutcome::Failed {
                error: opensesame_rotation_web::StepError::Refused
            }
        );
    }
}
