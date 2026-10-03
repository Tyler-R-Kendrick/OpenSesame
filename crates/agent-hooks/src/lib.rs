//! `OpenSesame` as an [agent-hooks/0.1] interceptor and approval resolver
//! (ADR 0150).
//!
//! agent-hooks is a framework-neutral control contract: a host (an agent
//! framework) builds an `AgentContext` at eight fixed points of its loop,
//! hands it to every registered interceptor, and must honour the combined
//! `Verdict` — `allow`, `deny`, or `transform`. `OpenSesame` takes the
//! interceptor's side of that contract. It does not re-implement the
//! contract: the canonical Rust core, `agent-hooks-sdk` (re-exported here as
//! [`sdk`]), owns envelope validation, canonical JSON, context identity,
//! verdict validation and composition, and every other language SDK binds to
//! the same core.
//!
//! What this crate adds is the `OpenSesame` judgement:
//!
//! - [`policy`] — the operator's tool rules, label lists and secret-guard
//!   posture, as strictly parsed data;
//! - [`secrets`] — high-precision, value-blind recognition and redaction of
//!   credential-shaped strings;
//! - [`labels`] — result labels (spec §5.4): what the interceptor marks the
//!   data an action produced with, and which marked data a tool may not take;
//! - [`interceptor`] — [`OpenSesameInterceptor`], which turns those into one
//!   verdict per emission;
//! - [`approval`] — [`BoundApprovalResolver`], the approval seam bound the way
//!   ADR 0086 binds approvals: a person's proof must be bound to a request
//!   that carries exactly the spec's `context_identity`;
//! - [`interaction`] — [`InteractionApprover`], the seam's transport to a
//!   person over an Identity-plane `Interaction` (ADR 0086), bound
//!   transitively: the identity rides in the details the server's request
//!   digest covers, and the approval is spent exactly once before it counts.
//!
//! agent-hooks is a cooperative contract, not a security boundary (spec
//! §1.4): the host decides whether verdicts are honoured. The authority
//! boundary stays where ADR 0005 put it — an agent holds `ConnectionRef`s,
//! and the Host API authorizes every use. The interceptor is defence in depth
//! in front of that boundary, at the places an agent loop moves content.
//!
//! [agent-hooks/0.1]: https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md

pub mod approval;
pub mod interaction;
pub mod interceptor;
pub mod labels;
pub mod policy;
pub mod secrets;

pub use agent_hooks as sdk;
pub use approval::{
    redact_for_approver, ApprovalBinding, ApprovalPrompt, ApproverError, BoundApprovalResolver,
    HumanApprover, HumanDecision,
};
pub use interaction::{InteractionApprover, InteractionApproverConfig, InteractionConfigError};
pub use interceptor::OpenSesameInterceptor;
pub use labels::{is_label, LABEL_CREDENTIAL_MATERIAL, REASON_LABEL_FLOW_DENIED};
pub use policy::{HookPolicy, PolicyError, SecretGuard, ToolDecision, ToolRule};

/// The contract version this crate speaks (`agent-hooks/0.1`).
pub const SPEC_VERSION: &str = agent_hooks::SPEC_VERSION;
