//! `opensesame hooks intercept --approver-url … --approver-ref …` — an
//! interceptor that can put its own escalation to a person (ADR 0159, spec §9).
//!
//! An escalation is a liftable deny: the host that gets it either has an
//! approval seam of its own or treats it as a deny. A host that spawns this
//! command per emission usually has none, so with an approver configured the
//! command asks one itself, through the same Identity-plane interaction the
//! Host's own runs use (`InteractionApprover`), and answers with the outcome:
//!
//! - **approved** — a plain `allow`. The approval was spent exactly once and
//!   its proof is bound to a request that carries this context's
//!   `context_identity`, computed over the context with every credential
//!   shape already replaced by a marker, so what the person saw held no
//!   secret;
//! - **declined, or bound to another request** — a `deny` naming which
//!   (`opensesame:approval_declined`, `opensesame:approval_not_bound`);
//! - **nobody answered in time, the channel failed, the approval was
//!   withdrawn or already spent** — the escalation itself, unchanged. It is
//!   still a deny by construction, and a host with its own seam may yet lift
//!   it. This command never invents a `host_error:*` reason: those belong to
//!   hosts (spec §11).
//!
//! The configuration is all or nothing: the Identity API URL, the approver's
//! inbox handle and the requester's bearer. A partial one is an error before
//! standard input is read, so a misconfigured approver can never quietly
//! become "no approver". Nothing set at all leaves escalations as they were.
//!
//! The bearer is a credential on the Identity API, so it has no flag: it is
//! read from `OPENSESAME_HOOK_APPROVER_BEARER` only, never from argv (where
//! `ps` would show it), and never printed. Standard input already carries the
//! context, so the environment is the one place it can come from. The bearer
//! must belong to a principal other than the approver's: the Identity API
//! refuses a requester that asks itself.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::Args;
use opensesame_agent_hooks::sdk::{
    ffi_surface, AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolver, Verdict,
};
use opensesame_agent_hooks::{
    redact_for_approver, BoundApprovalResolver, InteractionApprover, InteractionApproverConfig,
};
use secrecy::SecretString;

/// The only place the requester's bearer is read from.
pub const BEARER_ENV: &str = "OPENSESAME_HOOK_APPROVER_BEARER";

/// Poll cadence while a person is being waited for.
const POLL: Duration = Duration::from_secs(2);

#[derive(Args, Debug, Default)]
pub struct ApproverArgs {
    /// The Identity API that raises the approval (https; loopback http is
    /// allowed). With --approver-ref and the bearer in
    /// `OPENSESAME_HOOK_APPROVER_BEARER`, an escalation is put to a person
    /// instead of being returned for the host to resolve.
    #[arg(long = "approver-url", env = "OPENSESAME_HOOK_APPROVER_URL")]
    pub url: Option<String>,
    /// The approver's inbox handle (`inbox_…`, from their own
    /// `GET /v1/authorization-requests/inbox-ref`).
    #[arg(long = "approver-ref", env = "OPENSESAME_HOOK_APPROVER_REF")]
    pub handle: Option<String>,
    /// How long one escalation waits for a person, in seconds (30 to 3600).
    #[arg(
        long = "approver-timeout-seconds",
        env = "OPENSESAME_HOOK_APPROVER_TIMEOUT_SECONDS",
        default_value_t = 300
    )]
    pub timeout_seconds: u64,
}

/// What an escalation is put to, built from [`ApproverArgs`] and the
/// environment.
pub struct Approver {
    resolver: BoundApprovalResolver<InteractionApprover>,
}

fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

impl Approver {
    /// The configured approver, `None` when none of it is configured.
    ///
    /// # Errors
    ///
    /// The configuration is partial, or a part of it is unusable. The error
    /// names the setting, never a value.
    pub fn from_args(args: &ApproverArgs) -> Result<Option<Self>> {
        Self::from_parts(args, std::env::var(BEARER_ENV).ok().as_deref())
    }

    fn from_parts(args: &ApproverArgs, bearer: Option<&str>) -> Result<Option<Self>> {
        let url = present(args.url.as_deref());
        let handle = present(args.handle.as_deref());
        let bearer = present(bearer);
        if url.is_none() && handle.is_none() && bearer.is_none() {
            return Ok(None);
        }
        let (Some(url), Some(handle), Some(bearer)) = (url, handle, bearer) else {
            bail!(
                "an approver needs all of --approver-url (OPENSESAME_HOOK_APPROVER_URL), \
                 --approver-ref (OPENSESAME_HOOK_APPROVER_REF) and {BEARER_ENV}; \
                 set all three or none"
            );
        };
        let timeout = Duration::from_secs(args.timeout_seconds);
        let approver = InteractionApprover::new(InteractionApproverConfig {
            identity_api_url: url.to_owned(),
            bearer: SecretString::from(bearer.to_owned()),
            approver_ref: handle.to_owned(),
            ttl: timeout,
            poll_interval: POLL.min(timeout),
            deadline: timeout,
        })
        .context("the hook approver is not usable")?;
        Ok(Some(Self {
            resolver: BoundApprovalResolver::new(approver),
        }))
    }

    /// The verdict this command answers with, given what the interceptor
    /// decided for `context_text`. Anything but an escalation is returned
    /// untouched.
    pub async fn settle(&self, verdict: Verdict, context_text: &str) -> Verdict {
        if verdict.approval.is_none() {
            return verdict;
        }
        let Ok(context) = serde_json::from_str::<AgentContext>(context_text) else {
            return verdict;
        };
        // §9: the identity is of the context as the approver is shown it.
        let shown = redact_for_approver(&context);
        let Some(identity) = serde_json::to_string(&shown)
            .ok()
            .and_then(|text| ffi_surface::context_identity(&text).ok())
        else {
            return verdict;
        };
        let Some(point) = context
            .get("interception_point")
            .and_then(serde_json::Value::as_str)
            .and_then(|point| point.parse().ok())
        else {
            return verdict;
        };
        let resolution = self
            .resolver
            .resolve(ApprovalRequest {
                context_identity: Some(identity.clone()),
                interception_point: point,
                verdict: &verdict,
                context: &shown,
            })
            .await;
        // The echo rule: an answer to some other identity is no answer.
        if resolution.context_identity.as_deref() != Some(identity.as_str()) {
            return verdict;
        }
        match (resolution.outcome, resolution.verdict) {
            (ApprovalOutcome::Approve, Some(lifted)) if lifted.decision.permits() => lifted,
            (ApprovalOutcome::Reject, Some(refused)) => refused,
            _ => verdict,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(url: Option<&str>, handle: Option<&str>) -> ApproverArgs {
        ApproverArgs {
            url: url.map(str::to_owned),
            handle: handle.map(str::to_owned),
            timeout_seconds: 300,
        }
    }

    const URL: &str = "https://identity.example.com";
    const HANDLE: &str = "inbox_YXBwcm92ZXI.test-tag";

    #[test]
    fn nothing_set_is_no_approver() {
        assert!(Approver::from_parts(&args(None, None), None)
            .unwrap()
            .is_none());
        // A blank value is not a setting.
        assert!(Approver::from_parts(&args(Some(" "), Some("")), Some(""))
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_partial_configuration_is_refused_before_anything_is_read() {
        for (given, bearer) in [
            (args(Some(URL), None), None),
            (args(Some(URL), Some(HANDLE)), None),
            (args(Some(URL), None), Some("bearer")),
            (args(None, Some(HANDLE)), Some("bearer")),
            (args(None, None), Some("bearer")),
            (args(None, Some(HANDLE)), None),
        ] {
            let error = Approver::from_parts(&given, bearer).err().expect("refused");
            let text = format!("{error:#}");
            assert!(text.contains("all three or none"), "{text}");
        }
    }

    #[test]
    fn an_unusable_part_is_refused_and_the_bearer_is_never_shown() {
        let bearer = "requester-bearer-never-shown";
        for given in [
            args(Some("http://identity.example.com"), Some(HANDLE)),
            args(Some("not a url"), Some(HANDLE)),
            args(Some(URL), Some("not-an-inbox")),
            ApproverArgs {
                timeout_seconds: 5,
                ..args(Some(URL), Some(HANDLE))
            },
        ] {
            let error = Approver::from_parts(&given, Some(bearer))
                .err()
                .expect("refused");
            assert!(!format!("{error:#} {error:?}").contains(bearer));
        }
        assert!(
            Approver::from_parts(&args(Some(URL), Some(HANDLE)), Some(bearer))
                .unwrap()
                .is_some()
        );
    }
}
