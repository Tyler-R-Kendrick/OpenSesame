//! `OpenSesame` as an agent-hooks/0.1 interceptor.
//!
//! Two controls, one verdict per emission:
//!
//! - **Tool rules** at `pre_tool_call`: the operator's [`HookPolicy`] allows,
//!   escalates (a liftable deny, spec §5.1) or denies each tool by name.
//! - **The secret guard** everywhere content moves: `input`, both model
//!   seams, `post_tool_call` and `output`. A credential-shaped string is
//!   rewritten to a marker by a `transform` of the whole `$target`, so the
//!   model never reads it and the caller never receives it; in tool
//!   arguments, where a rewrite would hand the tool garbage, it is a plain
//!   deny — an agent passing a raw secret to a tool is exactly what a
//!   `ConnectionRef` exists to prevent (ADR 0005).
//!
//! - **Labels** (spec §5.4) ride every permit that produced data: a guard
//!   rewrite carries `opensesame:credential_material`, a tool result carries
//!   its rule's `labels`, and at `pre_tool_call` inputs deriving from a label
//!   the policy refuses are a plain deny. [`crate::labels`] fixes the order of
//!   the `pre_tool_call` refusals and says why.
//!
//! Nothing here decides at `agent_startup` or `agent_shutdown`: there is no
//! content to guard and no tool to call, and a transform is forbidden there.
//!
//! Every verdict is value-blind: reasons are fixed `opensesame:` identifiers
//! and messages name credential *kinds* and counts, never text from the
//! target (spec §14). The interception record the host writes keeps
//! `reason` and a truncated `message` and drops `transform.value`, so the
//! redacted content itself never reaches the audit trail either.

use agent_hooks::{
    ffi_surface, AgentContext, Decision, InterceptionPoint, Interceptor, Transform, Verdict,
};
use async_trait::async_trait;
use serde_json::Value;

use crate::labels::{self, LABEL_CREDENTIAL_MATERIAL};
use crate::policy::{HookPolicy, SecretGuard, ToolDecision, ToolMatch};
use crate::secrets;

pub use crate::labels::REASON_LABEL_FLOW_DENIED;

/// A tool the policy refuses outright.
pub const REASON_TOOL_DENIED: &str = "opensesame:tool_denied";
/// A tool the policy refuses unless a person approves (a liftable deny).
pub const REASON_TOOL_REQUIRES_APPROVAL: &str = "opensesame:tool_requires_approval";
/// Credential-shaped strings were rewritten to markers.
pub const REASON_SECRET_REDACTED: &str = "opensesame:secret_redacted";
/// Credential-shaped strings were found where they may not pass.
pub const REASON_RAW_SECRET: &str = "opensesame:raw_secret";
/// The context was missing a field this interceptor needs to decide. A host
/// validates the envelope before dispatch (spec §6.3), so this is the
/// interceptor failing closed on a host that did not.
pub const REASON_CONTEXT_UNREADABLE: &str = "opensesame:context_unreadable";

/// The largest context [`OpenSesameInterceptor::decide_json`] reads: the
/// spec's recommended serialized-context bound (§12.3, 5 MiB).
pub const MAX_CONTEXT_BYTES: usize = 5 * 1024 * 1024;

/// The name the interceptor registers under (`verdicts[].name`, spec §10.3).
pub const INTERCEPTOR_NAME: &str = "opensesame";

/// The interceptor. Stateless: the same context and policy give the same
/// verdict (spec §1.3), so concurrent emissions need no locking (spec §12.2).
#[derive(Debug, Clone, Default)]
pub struct OpenSesameInterceptor {
    policy: HookPolicy,
}

fn unreadable(what: &str) -> Verdict {
    Verdict::deny(
        Some(REASON_CONTEXT_UNREADABLE.into()),
        Some(format!("{what} is missing or malformed")),
    )
}

/// Where this interceptor's resurfaced labels live (spec §5.4).
const SOURCE_LABELS_PATH: &str = "extensions.opensesame.source_labels";

/// `tool_call.name`, required at both tool seams (spec §4.2).
fn tool_name(context: &AgentContext) -> Option<&str> {
    context
        .get("tool_call")
        .and_then(|call| call.get("name"))
        .and_then(Value::as_str)
}

impl OpenSesameInterceptor {
    /// An interceptor over `policy`. Build the policy with
    /// [`HookPolicy::parse`] (or call [`HookPolicy::check`]) first.
    #[must_use]
    pub const fn new(policy: HookPolicy) -> Self {
        Self { policy }
    }

    /// The policy in force.
    #[must_use]
    pub const fn policy(&self) -> &HookPolicy {
        &self.policy
    }

    /// The verdict for one context.
    #[must_use]
    pub fn decide(&self, context: &AgentContext) -> Verdict {
        let point = context
            .get("interception_point")
            .cloned()
            .and_then(|v| serde_json::from_value::<InterceptionPoint>(v).ok());
        match point {
            None => unreadable("interception_point"),
            Some(InterceptionPoint::AgentStartup | InterceptionPoint::AgentShutdown) => {
                Verdict::allow()
            }
            Some(InterceptionPoint::PreToolCall) => self.pre_tool_call(context),
            Some(point) => {
                let Ok(sources) = labels::source_labels(context) else {
                    return unreadable(SOURCE_LABELS_PATH);
                };
                let carried = labels::carried(&sources, &self.policy);
                let produced = match (point, tool_name(context)) {
                    (InterceptionPoint::PostToolCall, Some(name)) => self.policy.tool(name).labels,
                    (InterceptionPoint::PostToolCall, None) => return unreadable("tool_call.name"),
                    _ => &[],
                };
                let produced = produced.iter().map(String::as_str).chain(carried);
                self.guard_target(context, produced)
            }
        }
    }

    /// The verdict for one context as JSON text — the out-of-process form a
    /// host reaches over a pipe or a socket. A context over
    /// [`MAX_CONTEXT_BYTES`], or one that fails the SDK's §4 envelope check,
    /// is denied here rather than half-read: the interceptor fails closed on
    /// its own and does not rely on the host having validated.
    #[must_use]
    pub fn decide_json(&self, text: &str) -> Verdict {
        if text.len() > MAX_CONTEXT_BYTES {
            return Verdict::deny(
                Some(REASON_CONTEXT_UNREADABLE.into()),
                Some(format!(
                    "context exceeds {MAX_CONTEXT_BYTES} bytes (agent-hooks/0.1 §12.3)"
                )),
            );
        }
        // The SDK's detail names a field or a parse position, never content.
        if let Err((_, detail)) = ffi_surface::validate_envelope(text) {
            return Verdict::deny(
                Some(REASON_CONTEXT_UNREADABLE.into()),
                Some(format!(
                    "context fails the agent-hooks/0.1 envelope: {detail}"
                )),
            );
        }
        match serde_json::from_str::<AgentContext>(text) {
            Ok(context) => self.decide(&context),
            Err(_) => unreadable("context"),
        }
    }

    fn pre_tool_call(&self, context: &AgentContext) -> Verdict {
        let Some(name) = tool_name(context) else {
            return unreadable("tool_call.name");
        };
        // The name selects the rule and goes nowhere else: it is text the
        // context supplied, and a verdict message ends up in the record (§14).
        let rule = self.policy.tool(name);
        if rule.decision == ToolDecision::Deny {
            return Verdict::deny(
                Some(rule.reason.unwrap_or(REASON_TOOL_DENIED).into()),
                Some(rule.message.map_or_else(
                    || "the tool is denied by the OpenSesame hook policy".to_owned(),
                    str::to_owned,
                )),
            );
        }
        // A secret in the arguments is a plain deny even for a tool a person
        // could approve: a severity-max host would let the plain deny win
        // anyway (spec §5.1), and an approver shown `[redacted]` arguments
        // could not know what they were approving.
        if self.policy.secret_guard != SecretGuard::Off {
            let findings = context.get("target").map(secrets::scan).unwrap_or_default();
            if !findings.is_empty() {
                return Verdict::deny(
                    Some(REASON_RAW_SECRET.into()),
                    Some(format!(
                        "tool arguments carry credential material ({}); pass a ConnectionRef, never the secret",
                        findings.summary()
                    )),
                );
            }
        }
        let carried = match self.label_flow(context, &rule) {
            Ok(carried) => carried,
            Err(denied) => return *denied,
        };
        if rule.decision == ToolDecision::Escalate {
            return Verdict::escalate(
                Some(rule.reason.unwrap_or(REASON_TOOL_REQUIRES_APPROVAL).into()),
                Some(rule.message.map_or_else(
                    || "the tool needs a person's approval".to_owned(),
                    str::to_owned,
                )),
            );
        }
        // The tool's result derives from its arguments, so their labels ride
        // the permit forward (see `labels::carried`).
        labels::attach(Verdict::allow(), carried)
    }

    /// The plain deny for inputs deriving from a refused label, or for
    /// resurfaced labels this interceptor cannot read; otherwise the labels
    /// the inputs carry forward.
    fn label_flow(
        &self,
        context: &AgentContext,
        rule: &ToolMatch<'_>,
    ) -> Result<Vec<&str>, Box<Verdict>> {
        let Ok(sources) = labels::source_labels(context) else {
            return Err(Box::new(unreadable(SOURCE_LABELS_PATH)));
        };
        let refused = labels::refused(&sources, [rule.refuse_labels, &self.policy.refuse_labels]);
        if refused.is_empty() {
            Ok(labels::carried(&sources, &self.policy))
        } else {
            Err(Box::new(labels::flow_denied(&refused)))
        }
    }

    /// The guard's verdict over `target`. A permit carries `produced` — the
    /// labels of whatever made this data, and those its inputs carried
    /// forward — and, when the guard rewrote it, [`LABEL_CREDENTIAL_MATERIAL`].
    fn guard_target<'a>(
        &self,
        context: &AgentContext,
        produced: impl Iterator<Item = &'a str>,
    ) -> Verdict {
        if self.policy.secret_guard == SecretGuard::Off {
            return labels::attach(Verdict::allow(), produced);
        }
        let Some(target) = context.get("target") else {
            return unreadable("target");
        };
        let (redacted, findings) = secrets::redact(target);
        if findings.is_empty() {
            return labels::attach(Verdict::allow(), produced);
        }
        let summary = findings.summary();
        if self.policy.secret_guard == SecretGuard::Deny {
            return Verdict::deny(
                Some(REASON_RAW_SECRET.into()),
                Some(format!("content carries credential material ({summary})")),
            );
        }
        let rewrite = Verdict {
            decision: Decision::Transform,
            reason: Some(REASON_SECRET_REDACTED.into()),
            message: Some(format!("redacted credential material ({summary})")),
            transform: Some(Transform {
                path: "$target".into(),
                value: redacted,
            }),
            ..Verdict::allow()
        };
        labels::attach(
            rewrite,
            produced.chain(std::iter::once(LABEL_CREDENTIAL_MATERIAL)),
        )
    }
}

#[async_trait]
impl Interceptor for OpenSesameInterceptor {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        self.decide(context)
    }

    fn name(&self) -> Option<String> {
        Some(INTERCEPTOR_NAME.into())
    }
}
