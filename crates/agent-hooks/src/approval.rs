//! The approval seam (spec §9), bound the way `OpenSesame` binds approvals.
//!
//! agent-hooks and ADR 0086 arrived at the same rule from opposite ends. The
//! spec's `context_identity` is a digest of exactly what the approver was
//! shown, and a resolution must echo it byte for byte; an `OpenSesame`
//! approval counts only when the proof's `boundDigest` equals the
//! interaction's `requestDigest`. This module is the join, and the join is
//! transitive: a person's decision lifts a deny only when the proof they
//! produced is bound to a request, and that request carries exactly this
//! `context_identity`. An in-process approver may use the identity itself as
//! the request digest ([`ApprovalBinding::direct`]); an Identity-plane
//! `Interaction` cannot, because the server computes its own digest, so the
//! identity rides inside the authorization details that digest covers
//! ([`crate::interaction`]).
//!
//! [`BoundApprovalResolver`] implements the SDK's [`ApprovalResolver`] over a
//! [`HumanApprover`] port — whatever actually reaches a person (an
//! `Interaction`, a wallet pass, a terminal). It refuses to ask about an
//! identity-unbound request (`identity_provider: null`): a proof commits to a
//! digest, and there would be none to commit to.
//!
//! A person can only lift a deny to a plain `allow`. The resolver never
//! returns a `transform`: an approver that could rewrite the action would be
//! a second author of it, and ADR 0046 D11 keeps an approval narrowing, never
//! widening.

use agent_hooks::{
    AgentContext, ApprovalOutcome, ApprovalRequest, ApprovalResolution, ApprovalResolver,
    InterceptionPoint, Verdict,
};
use async_trait::async_trait;
use serde_json::Value;

use crate::secrets;

/// The person declined.
pub const REASON_APPROVAL_DECLINED: &str = "opensesame:approval_declined";
/// The proof was bound to a different request than the one asked about.
pub const REASON_APPROVAL_NOT_BOUND: &str = "opensesame:approval_not_bound";

/// What a person is asked about. `context_identity` is what the request they
/// answer must carry; `context` is the (host-redacted) context the identity
/// was computed over, for the approver to render as a display-safe summary.
#[derive(Debug, Clone, Copy)]
pub struct ApprovalPrompt<'a> {
    /// The spec's `context_identity` (never empty).
    pub context_identity: &'a str,
    /// Where in the agent loop the action waits.
    pub interception_point: InterceptionPoint,
    /// The liftable deny's reason.
    pub reason: Option<&'a str>,
    /// The liftable deny's message.
    pub message: Option<&'a str>,
    /// The context the identity covers.
    pub context: &'a AgentContext,
}

/// What an answer is bound to, as the transport observed it.
///
/// Three facts, and the resolver demands that all three line up: the digest
/// of the request the person was asked, the digest their proof committed to
/// (ADR 0086 `proof.boundDigest`), and the `context_identity` that request
/// carries. An approver reports what it observed; it never decides that the
/// binding holds — [`ApprovalBinding::holds_for`] does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalBinding {
    /// The digest of the request the person was asked (ADR 0086
    /// `requestDigest`).
    pub request_digest: String,
    /// The digest the person's proof committed to, or `None` when the
    /// authority refused the binding or reported none.
    pub bound_digest: Option<String>,
    /// The `context_identity` the request carries, or `None` when it carries
    /// none, more than one, or not the details that were sent.
    pub carried_identity: Option<String>,
}

impl ApprovalBinding {
    /// A binding for a transport whose request digest *is* the identity (an
    /// in-process or terminal approver): the request is the identity and
    /// carries itself, and `bound_digest` is what the proof committed to.
    #[must_use]
    pub fn direct(context_identity: &str, bound_digest: &str) -> Self {
        Self {
            request_digest: context_identity.to_owned(),
            bound_digest: Some(bound_digest.to_owned()),
            carried_identity: Some(context_identity.to_owned()),
        }
    }

    /// True only when the proof is bound to the request that was asked, and
    /// that request carries exactly `context_identity`.
    #[must_use]
    pub fn holds_for(&self, context_identity: &str) -> bool {
        !self.request_digest.is_empty()
            && !context_identity.is_empty()
            && self.bound_digest.as_deref() == Some(self.request_digest.as_str())
            && self.carried_identity.as_deref() == Some(context_identity)
    }
}

/// A person's answer and what it is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HumanDecision {
    /// True for approve, false for decline.
    pub approved: bool,
    /// What the answer is bound to.
    pub binding: ApprovalBinding,
}

/// Why no decision came back. The resolver treats every variant as
/// `unresolved`, which the host enforces as a deny (spec §9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproverError {
    /// Nobody answered before the deadline, or the request lapsed.
    TimedOut,
    /// The channel to a person failed.
    Unavailable,
    /// The request was withdrawn before an approval could be spent.
    Withdrawn,
    /// The approval was already spent. Lifting this deny on it would replay
    /// one person's approval for a second emission.
    Spent,
}

/// The port to a person.
#[async_trait]
pub trait HumanApprover: Send + Sync {
    /// Ask a person about `prompt` and wait for their decision.
    ///
    /// # Errors
    ///
    /// [`ApproverError`] when no decision was obtained.
    async fn ask(&self, prompt: ApprovalPrompt<'_>) -> Result<HumanDecision, ApproverError>;
}

/// The SDK resolver over a [`HumanApprover`].
#[derive(Debug, Clone)]
pub struct BoundApprovalResolver<A> {
    approver: A,
}

impl<A> BoundApprovalResolver<A> {
    /// A resolver that asks `approver`.
    pub const fn new(approver: A) -> Self {
        Self { approver }
    }
}

fn resolution(
    outcome: ApprovalOutcome,
    echo: Option<String>,
    verdict: Option<Verdict>,
) -> ApprovalResolution {
    ApprovalResolution {
        outcome,
        context_identity: echo,
        verdict,
    }
}

#[async_trait]
impl<A: HumanApprover> ApprovalResolver for BoundApprovalResolver<A> {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        // The echo rule (spec §9): whatever came in goes back unchanged.
        let echo = request.context_identity.clone();
        let Some(identity) = request
            .context_identity
            .as_deref()
            .filter(|d| !d.is_empty())
        else {
            return resolution(ApprovalOutcome::Unresolved, echo, None);
        };
        let prompt = ApprovalPrompt {
            context_identity: identity,
            interception_point: request.interception_point,
            reason: request.verdict.reason.as_deref(),
            message: request.verdict.message.as_deref(),
            context: request.context,
        };
        match self.approver.ask(prompt).await {
            Err(_) => resolution(ApprovalOutcome::Unresolved, echo, None),
            Ok(decision) if !decision.binding.holds_for(identity) => resolution(
                ApprovalOutcome::Reject,
                echo,
                Some(Verdict::deny(
                    Some(REASON_APPROVAL_NOT_BOUND.into()),
                    Some("the approval proof is bound to a different request".into()),
                )),
            ),
            Ok(decision) if decision.approved => {
                resolution(ApprovalOutcome::Approve, echo, Some(Verdict::allow()))
            }
            Ok(_) => resolution(
                ApprovalOutcome::Reject,
                echo,
                Some(Verdict::deny(
                    Some(REASON_APPROVAL_DECLINED.into()),
                    Some("a person declined the action".into()),
                )),
            ),
        }
    }
}

/// An approval redactor for the SDK emitter
/// (`InterceptionEmitter::set_approval_redactor`): every credential-shaped
/// string in the context becomes a marker before the context leaves for an
/// approver. The host computes `context_identity` over the redacted context
/// (spec §9), so the identity a person's approval is bound to is the identity
/// of what they were actually shown — and what they were shown held no secret.
#[must_use]
pub fn redact_for_approver(context: &AgentContext) -> AgentContext {
    match secrets::redact(&Value::Object(context.clone())).0 {
        Value::Object(redacted) => redacted,
        // `redact` preserves the shape of its input; an object stays one.
        _ => AgentContext::new(),
    }
}
