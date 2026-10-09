//! The Host's approver for escalated agent actions (ADR 0159): the operator's
//! deployment configuration, and the per-run approval seam built from it.
//!
//! A tool rule that escalates is a liftable deny (agent-hooks/0.1 §5.1), and
//! only the §9 approval seam lifts it. The Host's seam is an
//! [`InteractionApprover`]: it raises an Identity-plane interaction, bound to
//! the request's `context_identity`, to the person whose inbox handle was
//! configured, and waits for their passkey-backed answer. Two things say how:
//!
//! - **the operator's deployment** (this module, the `OPENSESAME_AGENT_HOOKS_APPROVER_*`
//!   variables of `.env.schema`) — which Identity API, and the requester's
//!   bearer on it. The bearer must be a principal distinct from every
//!   approver: the Identity API refuses a requester asking itself;
//! - **the organization** (`agent_hook_approvers`, `GET|PUT
//!   /api/v1/agent-hooks/approver`) — *who* is asked. The operator's
//!   `OPENSESAME_AGENT_HOOKS_APPROVER_REF`, when set, is the default for an
//!   organization that names nobody.
//!
//! The configuration is read once at startup and validated by the same
//! constructor the run uses, so a value that would fail at the first
//! escalation refuses to start instead. A partially configured approver (a
//! URL without a bearer, a bearer without a URL, tuning without either)
//! refuses to start too. A deployment that configures none of it is
//! conformant: every escalation stays a denial (§9), and nothing is ever
//! asked of a person.
//!
//! What goes wrong at run time is always a denial. An organization with no
//! approver, a stored handle that no longer builds an approver, or a store
//! that cannot be read, is "no resolver" for that run; nothing is lifted.

use std::time::Duration;

use opensesame_agent_hooks::interaction::DEFAULT_POLL_INTERVAL;
use opensesame_agent_hooks::sdk::ApprovalResolver;
use opensesame_agent_hooks::{
    BoundApprovalResolver, InteractionApprover, InteractionApproverConfig, InteractionConfigError,
};
use opensesame_domain::OrganizationId;
use secrecy::SecretString;

use crate::app_state::AppState;

pub(crate) const ENV_URL: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_URL";
pub(crate) const ENV_BEARER: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_BEARER";
pub(crate) const ENV_REF: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_REF";
pub(crate) const ENV_TTL: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_TTL_SECONDS";
pub(crate) const ENV_POLL: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_POLL_MS";
pub(crate) const ENV_DEADLINE: &str = "OPENSESAME_AGENT_HOOKS_APPROVER_DEADLINE_SECONDS";

/// How long an interaction stays answerable when the operator says nothing.
const DEFAULT_TTL: Duration = Duration::from_secs(300);

/// Outbox event for a replaced approver. The payload carries the handle's
/// digest, never the handle.
pub(crate) const EVENT_APPROVER_UPDATED: &str = "agent_hooks.approver.updated";

/// Whether `handle` is shaped like an Identity-plane inbox handle
/// (`inbox_<base64url>.<tag>`): the prefix, a plausible length, and the
/// URL-safe alphabet, so a stored value can never smuggle a URL, a space or
/// a control character toward the Identity API.
pub(crate) fn valid_approver_ref(handle: &str) -> bool {
    handle.starts_with("inbox_")
        && (8..=256).contains(&handle.len())
        && handle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// A handle that satisfies [`InteractionApprover::new`], used only to run the
/// constructor's validation at startup when the operator named no default.
const VALIDATION_REF: &str = "inbox_startup-validation";

/// Why the approver's deployment configuration refuses to start. Names the
/// variable, never its value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApproverConfigError {
    /// Some of the approver's variables are set and a required one is not.
    #[error("{missing} is required when any agent-hooks approver variable is set")]
    Partial { missing: &'static str },
    /// A variable's value is unusable.
    #[error("{variable} is not usable: {reason}")]
    Invalid {
        variable: &'static str,
        reason: &'static str,
    },
}

/// The operator's approver configuration: where the Identity API is, and the
/// requester's credential on it.
#[derive(Debug, Clone)]
pub struct ApproverSettings {
    identity_api_url: String,
    bearer: SecretString,
    default_ref: Option<String>,
    ttl: Duration,
    poll_interval: Duration,
    deadline: Duration,
}

fn invalid(variable: &'static str, reason: &'static str) -> ApproverConfigError {
    ApproverConfigError::Invalid { variable, reason }
}

fn number(
    lookup: &dyn Fn(&str) -> Option<String>,
    variable: &'static str,
) -> Result<Option<u64>, ApproverConfigError> {
    let Some(raw) = lookup(variable).filter(|v| !v.trim().is_empty()) else {
        return Ok(None);
    };
    raw.trim()
        .parse::<u64>()
        .map(Some)
        .map_err(|_| invalid(variable, "not a whole number"))
}

impl ApproverSettings {
    /// Read the process environment.
    ///
    /// # Errors
    ///
    /// [`ApproverConfigError`] when the approver is partially or wrongly
    /// configured. `Ok(None)` when none of it is configured.
    pub fn from_env() -> Result<Option<Self>, ApproverConfigError> {
        Self::from_lookup(&|name| std::env::var(name).ok())
    }

    /// Read from a lookup, so tests never touch the process environment.
    ///
    /// # Errors
    ///
    /// As [`Self::from_env`].
    pub fn from_lookup(
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, ApproverConfigError> {
        let text = |name: &str| lookup(name).filter(|v| !v.trim().is_empty());
        let url = text(ENV_URL);
        let bearer = text(ENV_BEARER);
        let default_ref = text(ENV_REF);
        let any = [ENV_TTL, ENV_POLL, ENV_DEADLINE]
            .iter()
            .any(|name| text(name).is_some())
            || url.is_some()
            || bearer.is_some()
            || default_ref.is_some();
        if !any {
            return Ok(None);
        }
        let identity_api_url = url.ok_or(ApproverConfigError::Partial { missing: ENV_URL })?;
        let bearer = bearer.ok_or(ApproverConfigError::Partial {
            missing: ENV_BEARER,
        })?;
        let ttl = number(lookup, ENV_TTL)?.map_or(DEFAULT_TTL, Duration::from_secs);
        let poll_interval =
            number(lookup, ENV_POLL)?.map_or(DEFAULT_POLL_INTERVAL, Duration::from_millis);
        let deadline = number(lookup, ENV_DEADLINE)?.map_or(ttl, Duration::from_secs);
        let settings = Self {
            identity_api_url,
            bearer: SecretString::from(bearer),
            default_ref: default_ref.map(|value| value.trim().to_owned()),
            ttl,
            poll_interval,
            deadline,
        };
        // The run's own constructor is the validator: whatever it would
        // refuse at the first escalation is refused now.
        settings
            .approver(settings.default_ref.as_deref().unwrap_or(VALIDATION_REF))
            .map_err(|refused| match refused {
                InteractionConfigError::InvalidUrl => invalid(ENV_URL, "not a usable URL"),
                InteractionConfigError::InsecureUrl => {
                    invalid(ENV_URL, "must be https (loopback http is allowed)")
                }
                InteractionConfigError::InvalidApproverRef => {
                    invalid(ENV_REF, "not an inbox handle")
                }
                InteractionConfigError::EmptyBearer => invalid(ENV_BEARER, "empty"),
                InteractionConfigError::TtlOutOfRange => {
                    invalid(ENV_TTL, "must be between 30 and 3600 seconds")
                }
                InteractionConfigError::InvalidTiming => invalid(
                    ENV_POLL,
                    "poll and deadline must be non-zero, and the poll within the deadline",
                ),
                InteractionConfigError::Transport => {
                    invalid(ENV_URL, "the transport could not be built")
                }
            })?;
        Ok(Some(settings))
    }

    /// The operator's default approver handle, for an organization that
    /// names nobody.
    #[must_use]
    pub fn default_ref(&self) -> Option<&str> {
        self.default_ref.as_deref()
    }

    /// An approver that asks the person behind `approver_ref`.
    ///
    /// # Errors
    ///
    /// [`InteractionConfigError`] naming what is unusable.
    pub fn approver(
        &self,
        approver_ref: &str,
    ) -> Result<InteractionApprover, InteractionConfigError> {
        InteractionApprover::new(InteractionApproverConfig {
            identity_api_url: self.identity_api_url.clone(),
            bearer: self.bearer.clone(),
            approver_ref: approver_ref.to_owned(),
            ttl: self.ttl,
            poll_interval: self.poll_interval,
            deadline: self.deadline,
        })
    }
}

/// The §9 approval seam for one run of `organization_id`'s, or `None` when
/// nobody is to be asked (every escalation then stays a denial).
///
/// The handle is the organization's own, else the operator's default. A
/// store that cannot be read, or a handle that no longer builds an approver,
/// is answered `None` too: a run never asks somebody it cannot name.
pub(crate) async fn resolver_for(
    state: &AppState,
    organization_id: &OrganizationId,
) -> Option<Box<dyn ApprovalResolver>> {
    let settings = state.agent_hook_approver.as_ref()?;
    let stored = match state
        .db
        .agent_hook_approver(&organization_id.to_string())
        .await
    {
        Ok(stored) => stored,
        Err(error) => {
            tracing::error!(%error, "the agent-hooks approver could not be read; escalations are denied");
            return None;
        }
    };
    // A row that clears the handle is a decision to ask nobody, not a
    // fall-through to the operator's default.
    let approver_ref = match stored {
        Some(row) => row.approver_ref,
        None => settings.default_ref().map(str::to_owned),
    }?;
    match settings.approver(&approver_ref) {
        Ok(approver) => Some(Box::new(BoundApprovalResolver::new(approver))),
        Err(refused) => {
            tracing::error!(%refused, "the stored agent-hooks approver is unusable; escalations are denied");
            None
        }
    }
}

#[cfg(test)]
#[path = "agent_hook_approver_tests.rs"]
mod tests;
