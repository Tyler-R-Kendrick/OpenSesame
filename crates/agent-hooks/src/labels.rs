//! Result labels and label-flow control (agent-hooks/0.1 §5.4, §7.3).
//!
//! A verdict's `result_labels` is the interceptor's return channel for
//! provenance: the host persists the labels beside the data the guarded
//! action produced, and resurfaces them as
//! `extensions.<namespace>.source_labels` on a later emission whose `target`
//! derives from that data. `OpenSesame`'s namespace is `opensesame`, the name
//! it registers under. Two things ride that channel:
//!
//! - **The built-in label** [`LABEL_CREDENTIAL_MATERIAL`]. Whenever the secret
//!   guard rewrites content, the data that action produced derived from
//!   something that carried a credential. The redaction removed the value; the
//!   label keeps the fact, so an operator can refuse any tool whose inputs
//!   descend from it.
//! - **Operator labels** a tool rule's `labels` puts on that tool's results
//!   (`acme:pii` on a CRM lookup), and the `refuse_labels` a rule — or the
//!   policy as a whole — refuses to let reach a tool's inputs.
//! - **Carried labels**. A label is sticky: a permit also names every
//!   resurfaced `source_labels` entry the policy knows, so data derived from
//!   labelled data stays labelled. Without it a host that resurfaces labels
//!   one hop at a time would lose a tool result's label at the model call,
//!   and the model's next tool call would arrive unlabelled — the very flow a
//!   refusal exists to stop. Only strings the policy names ride forward: the
//!   record keeps `result_labels` verbatim, so an echoed context string would
//!   be a channel for content.
//!
//! Labels ride permit verdicts only. §5.4 forbids persisting labels for an
//! action that did not proceed, and the canonical core's composition unions
//! labels from permit verdicts only — but it leaves a winning deny's own
//! labels in place, so the interceptor never puts a label on a deny.
//!
//! At `pre_tool_call` the order is fixed and every refusal is a plain deny:
//!
//! 1. a tool rule's `deny` — the operator refused the tool outright, whatever
//!    its arguments or their provenance;
//! 2. a credential in the arguments (`opensesame:raw_secret`) — direct
//!    evidence about the content itself. It is reported before label flow
//!    because the record keeps only the winning reason, and an agent trying
//!    to hand a tool a raw secret is the stronger finding for an audit trail
//!    than an inference from provenance; both refuse, so nothing else differs;
//! 3. label flow (`opensesame:label_flow_denied`) — provenance the operator
//!    refuses for this tool. `source_labels` in our namespace that is not an
//!    array of strings is `opensesame:context_unreadable`: a host that garbles
//!    provenance must not thereby launder it. The check runs whether or not
//!    the policy refuses anything, so a broken host shows up at once rather
//!    than on the day a refusal is added — and at every content seam, not
//!    only this one, since a label dropped there would never be carried to
//!    the tool call it should refuse;
//! 4. a rule's `escalate` — liftable, so it comes after every plain deny, the
//!    same order the §5.1 severity ladder gives a multi-interceptor host.
//!
//! Every label that reaches a verdict message comes from the policy, which
//! [`is_label`] has vetted: the intersection is taken in the policy's order
//! and the context's own strings are only compared, never repeated. A label
//! another interceptor produced may be any string, so incoming labels are
//! matched exactly and not syntax-checked.

use std::collections::HashSet;

use agent_hooks::{AgentContext, Verdict};

use crate::policy::HookPolicy;

/// The label every guard rewrite carries: the data this action produced
/// derives from something that carried credential material.
pub const LABEL_CREDENTIAL_MATERIAL: &str = "opensesame:credential_material";

/// A tool whose inputs derive from data carrying a label the policy refuses
/// for it. A plain deny: provenance does not change with a person's say-so.
pub const REASON_LABEL_FLOW_DENIED: &str = "opensesame:label_flow_denied";

/// The `extensions` namespace the host resurfaces this interceptor's labels
/// under (§5.4): the name the interceptor registers with.
pub const LABEL_NAMESPACE: &str = crate::interceptor::INTERCEPTOR_NAME;

/// The member of `extensions.opensesame` that carries resurfaced labels.
pub const SOURCE_LABELS: &str = "source_labels";

/// The longest label a policy may name, in bytes.
pub const MAX_LABEL_BYTES: usize = 64;

/// The most labels one policy list may hold.
pub const MAX_LABELS: usize = 16;

/// True when `label` is `namespace:name` — `^[a-z][a-z0-9_]*:[a-z0-9_.:-]+$`
/// — and at most [`MAX_LABEL_BYTES`] long. A label is a payload-free
/// identifier, which is what lets a verdict message name it.
#[must_use]
pub fn is_label(label: &str) -> bool {
    if label.len() > MAX_LABEL_BYTES {
        return false;
    }
    let Some((namespace, name)) = label.split_once(':') else {
        return false;
    };
    let mut head = namespace.bytes();
    head.next().is_some_and(|b| b.is_ascii_lowercase())
        && head.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b':' | b'-')
        })
}

/// The position of the first entry that makes `list` unusable as a policy
/// label list: a malformed label, a repeat, or the first past [`MAX_LABELS`].
pub(crate) fn first_fault(list: &[String]) -> Option<usize> {
    let mut seen = HashSet::new();
    list.iter()
        .enumerate()
        .find(|(index, label)| {
            *index >= MAX_LABELS || !is_label(label) || !seen.insert(label.as_str())
        })
        .map(|(index, _)| index)
}

/// The resurfaced `extensions.opensesame.source_labels`, or `Err(())` when
/// something on that path is present but not the shape §4.6 and §5.4 give it.
/// Absence anywhere along the path is no labels.
pub(crate) fn source_labels(context: &AgentContext) -> Result<HashSet<&str>, ()> {
    let Some(extensions) = context.get("extensions") else {
        return Ok(HashSet::new());
    };
    let Some(ours) = extensions.as_object().ok_or(())?.get(LABEL_NAMESPACE) else {
        return Ok(HashSet::new());
    };
    let Some(labels) = ours.as_object().ok_or(())?.get(SOURCE_LABELS) else {
        return Ok(HashSet::new());
    };
    labels
        .as_array()
        .ok_or(())?
        .iter()
        .map(|label| label.as_str().ok_or(()))
        .collect()
}

/// The resurfaced labels this interceptor carries forward: every label in
/// `sources` that the built-in label or some policy list names, in that
/// order, each once. A label is sticky — data derived from labelled data is
/// labelled — so a host that resurfaces labels one hop at a time (tool result
/// → model input) still sees them on the hop after (model output → the next
/// tool's arguments). Only strings the policy names ride forward: the record
/// keeps `result_labels` verbatim (spec §10.3), and a context string echoed
/// there would be a channel for content.
pub(crate) fn carried<'a>(sources: &HashSet<&str>, policy: &'a HookPolicy) -> Vec<&'a str> {
    let rules = policy
        .tools
        .iter()
        .flat_map(|rule| rule.labels.iter().chain(&rule.refuse_labels));
    dedup(
        std::iter::once(LABEL_CREDENTIAL_MATERIAL)
            .chain(policy.refuse_labels.iter().chain(rules).map(String::as_str))
            .filter(|label| sources.contains(label)),
    )
}

/// The refused labels `sources` carries, in the policy's order (the rule's
/// list, then the policy-wide one), each once.
pub(crate) fn refused<'a>(sources: &HashSet<&str>, lists: [&'a [String]; 2]) -> Vec<&'a str> {
    dedup(
        lists
            .into_iter()
            .flatten()
            .map(String::as_str)
            .filter(|label| sources.contains(label)),
    )
}

/// The plain deny for a refused label flow. `labels` are policy strings.
pub(crate) fn flow_denied(labels: &[&str]) -> Verdict {
    Verdict::deny(
        Some(REASON_LABEL_FLOW_DENIED.into()),
        Some(format!(
            "tool inputs derive from data labelled {}, which the OpenSesame hook policy refuses for this tool",
            labels.join(", ")
        )),
    )
}

/// `verdict` carrying `labels`, deduplicated in first-seen order. A verdict
/// that does not permit is returned bare: §5.4 persists no label for an
/// action that did not proceed.
pub(crate) fn attach<'a>(
    mut verdict: Verdict,
    labels: impl IntoIterator<Item = &'a str>,
) -> Verdict {
    if verdict.decision.permits() {
        verdict.result_labels = dedup(labels).into_iter().map(str::to_owned).collect();
    } else {
        verdict.result_labels.clear();
    }
    verdict
}

fn dedup<'a>(labels: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    labels
        .into_iter()
        .filter(|label| seen.insert(*label))
        .collect()
}
