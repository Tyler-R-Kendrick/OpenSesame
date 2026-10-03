//! The Identity API's wire shapes this approver speaks, and the checks that
//! turn a consumed interaction into an [`ApprovalBinding`].
//!
//! Requests mirror `CreateAuthorizationRequest` and `CreateInteraction` in
//! `packages/control-plane/openapi.json` (a contract test holds them to it).
//! Responses are read field by field; a field that is missing or of the wrong
//! type makes the response unusable, never a default.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::approval::{ApprovalBinding, ApprovalPrompt};
use crate::secrets;

/// The RFC 9396 `type` of the one authorization detail this approver sends.
pub const DETAIL_TYPE: &str = "agent_hooks_approval";
/// The interaction kind for an agent action awaiting a person (ADR 0046: an
/// authorization request is "allow this call"; ADR 0086 fronts it).
pub const INTERACTION_KIND: &str = "authorization_request";
/// Display strings longer than this are left out of the detail.
const MAX_DISPLAY: usize = 128;
/// Interaction references are `base64url.base64url` with a short prefix.
const MAX_REF: usize = 256;

/// `POST /v1/authorization-requests` — the subject the interaction fronts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAuthorizationRequest<'a> {
    pub approver_ref: &'a str,
    pub authorization_details: &'a [Value],
    pub binding_message: &'static str,
    pub ttl_seconds: u64,
}

/// `{kind, subjectId}` of `CreateInteraction.subject`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionSubject<'a> {
    pub kind: &'static str,
    pub subject_id: &'a str,
}

/// `POST /v1/interactions`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInteraction<'a> {
    pub kind: &'static str,
    pub subject: InteractionSubject<'a>,
    pub approver_ref: &'a str,
    pub authorization_details: &'a [Value],
    pub ttl_seconds: u64,
}

/// The requester's binding message for the authorization request. Fixed per
/// interception point, so no agent-supplied text reaches it; the interaction
/// derives its own from the detail.
#[must_use]
pub fn binding_message(prompt: &ApprovalPrompt<'_>) -> &'static str {
    use agent_hooks::InterceptionPoint as P;
    match prompt.interception_point {
        P::AgentStartup => "Approve an agent action: agent_startup",
        P::Input => "Approve an agent action: input",
        P::PreModelCall => "Approve an agent action: pre_model_call",
        P::PostModelCall => "Approve an agent action: post_model_call",
        P::PreToolCall => "Approve an agent action: pre_tool_call",
        P::PostToolCall => "Approve an agent action: post_tool_call",
        P::Output => "Approve an agent action: output",
        P::AgentShutdown => "Approve an agent action: agent_shutdown",
    }
}

/// A string safe to put in front of a person: short, a machine identifier
/// (the spec's `reason` is one, §5; a tool name and an agent id are too), and
/// not credential-shaped. Anything else — prose, whitespace, a path with
/// content in it — is left out rather than trimmed, because a reason written
/// by another interceptor is free text this approver did not author, and
/// what is sent here is stored by the Identity API and shown to a person.
fn display_safe(value: Option<&Value>) -> Option<&str> {
    let text = value?.as_str()?;
    let fits = !text.is_empty() && text.len() <= MAX_DISPLAY;
    let identifier = text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':' | b'/' | b'@'));
    let clean = secrets::scan(&Value::String(text.to_owned())).is_empty();
    (fits && identifier && clean).then_some(text)
}

/// The one authorization detail an approval is asked with.
///
/// `context_identity` is the binding: the server's `requestDigest` covers the
/// whole detail, so a proof bound to that digest is bound to this identity.
/// The rest is a display-safe summary — the interception point, the deny's
/// reason, the agent and the tool — so the person knows what they are
/// approving; tool arguments, messages and results never travel.
#[must_use]
pub fn authorization_detail(prompt: &ApprovalPrompt<'_>) -> Value {
    let point = prompt.interception_point.as_str();
    let mut detail = Map::new();
    detail.insert("type".into(), json!(DETAIL_TYPE));
    detail.insert("actions".into(), json!([point]));
    let tool = prompt
        .context
        .get("tool_call")
        .and_then(|call| display_safe(call.get("name")));
    if let Some(tool) = tool {
        detail.insert("locations".into(), json!([tool]));
    }
    detail.insert("spec".into(), json!(agent_hooks::SPEC_VERSION));
    detail.insert("context_identity".into(), json!(prompt.context_identity));
    detail.insert("interception_point".into(), json!(point));
    let reason = prompt.reason.map(|r| Value::String(r.to_owned()));
    if let Some(reason) = display_safe(reason.as_ref()) {
        detail.insert("reason".into(), json!(reason));
    }
    let agent = prompt
        .context
        .get("agent")
        .and_then(|agent| display_safe(agent.get("id")));
    if let Some(agent) = agent {
        detail.insert("agent".into(), json!(agent));
    }
    Value::Object(detail)
}

/// `authReqId` of an `AuthorizationRequest`. It is used as a path segment
/// (the withdrawal is `/v1/authorization-requests/{id}/cancel`), so anything
/// outside the identifier alphabet makes the response unusable.
#[must_use]
pub fn auth_req_id(body: Option<&Value>) -> Option<&str> {
    let id = body?.get("authReqId")?.as_str()?;
    let path_safe = id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
    (!id.is_empty() && id.len() <= MAX_REF && path_safe).then_some(id)
}

/// What `POST /v1/interactions` handed back that the approver keeps.
#[derive(Debug, Clone)]
pub struct Created {
    pub reference: String,
    pub url: String,
    pub request_digest: String,
}

/// Read an `InteractionCreated`. The reference is used as a path segment, so
/// anything but its own alphabet makes the response unusable.
#[must_use]
pub fn created(body: Option<&Value>) -> Option<Created> {
    let body = body?;
    let reference = body.get("ref")?.as_str()?;
    let url = body.get("url")?.as_str()?;
    let request_digest = body.get("requestDigest")?.as_str()?;
    // `base64url.base64url`: a dot only between two segments, so no `.` or
    // `..` segment can walk the path to another route on the origin.
    let path_safe = reference
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && !reference.starts_with('.')
        && !reference.ends_with('.')
        && !reference.contains("..");
    if reference.is_empty() || reference.len() > MAX_REF || !path_safe || request_digest.is_empty()
    {
        return None;
    }
    Some(Created {
        reference: reference.to_owned(),
        url: url.to_owned(),
        request_digest: request_digest.to_owned(),
    })
}

/// The identity carried by `details`, when they are exactly `sent` and hold
/// exactly one detail of [`DETAIL_TYPE`].
fn carried_identity(details: Option<&Value>, sent: &[Value]) -> Option<String> {
    let details = details?.as_array()?;
    if details.as_slice() != sent {
        return None;
    }
    let mut ours = details
        .iter()
        .filter(|d| d.get("type").and_then(Value::as_str) == Some(DETAIL_TYPE));
    let only = ours.next()?;
    if ours.next().is_some() {
        return None;
    }
    only.get("context_identity")?.as_str().map(str::to_owned)
}

/// The binding a successful consume attests to.
///
/// The Identity API spends an approval only after recomputing the request
/// digest from the stored interaction and checking that the proof's
/// `boundDigest` equals it (`verifyInteractionBinding`), so a consumed detail
/// is the server's attestation that the proof is bound to the digest it
/// reports. That digest must be the one the interaction was created with, and
/// the details it covers must be exactly the ones sent.
#[must_use]
pub fn consumed_binding(
    body: Option<&Value>,
    created: &Created,
    sent: &[Value],
) -> ApprovalBinding {
    let consumed = body.is_some_and(|b| {
        b.get("status").and_then(Value::as_str) == Some("consumed")
            && b.get("kind").and_then(Value::as_str) == Some(INTERACTION_KIND)
    });
    let bound_digest = body
        .filter(|_| consumed)
        .and_then(|b| b.get("requestDigest"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let carried = body
        .filter(|_| consumed)
        .and_then(|b| carried_identity(b.get("authorizationDetails"), sent));
    ApprovalBinding {
        request_digest: created.request_digest.clone(),
        bound_digest,
        carried_identity: carried,
    }
}

/// The binding of an approval the server refused to spend because its proof
/// did not bind (`digest_mismatch`): nothing is bound.
#[must_use]
pub fn refused_binding(created: &Created) -> ApprovalBinding {
    ApprovalBinding {
        request_digest: created.request_digest.clone(),
        bound_digest: None,
        carried_identity: None,
    }
}

/// The binding of a refusal.
///
/// A decline needs no proof — refusing only ever removes authority — and the
/// Identity API says nothing about *what* was refused beyond the fact: its
/// deny route accepts only a body echoing the stored `requestDigest`, so a
/// denied interaction is a denial of exactly the request this approver
/// created, whose details are exactly the ones it sent. The binding states
/// that (the created digest, bound to itself, carrying the identity that was
/// sent), so the resolver — which reads any answer whose binding does not
/// hold as `approval_not_bound` — reads a decline as what it is:
/// `approval_declined`. It cannot lift a deny: the resolver rejects on it.
#[must_use]
pub fn declined_binding(created: &Created, sent: &[Value]) -> ApprovalBinding {
    ApprovalBinding {
        request_digest: created.request_digest.clone(),
        bound_digest: Some(created.request_digest.clone()),
        carried_identity: carried_identity(Some(&Value::Array(sent.to_vec())), sent),
    }
}
