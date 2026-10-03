//! The points the fixed verbs do not cover: a tool known only by name, and
//! a model exchange.
//!
//! [`HookedTransport`](super::HookedTransport) brackets the eleven verbs of
//! ADR 0076 §1 and ADR 0082 §3, each a typed Rust call. This module is the
//! same engine — the same lock, the same lifecycle phase, the same context
//! builder, emitter and label ledger — reached with untyped JSON, so a caller
//! that mediates something the verbs cannot name goes through the one
//! emission path rather than a second one.
//!
//! # No production run path calls these
//!
//! The runs this crate orders make no model calls: ADR 0076 §8 keeps the
//! model in the remote runner, on the far side of the tool boundary, and ADR
//! 0081's relay carries sealed observation frames, not a model exchange. So
//! the `rotation-web` host declares `tool_calls` and never `model_calls`
//! (`docs/validation/agent-hooks-conformance.md`), and nothing here is on a
//! rotation or a capture run's path. [`HookSession::pre_model_call`] and
//! [`HookSession::post_model_call`] exist so the emission engine can be
//! exercised end to end, under the CTK's own contract of a mocked model and
//! mocked tools, by the second conformance claim — the one that is about the
//! engine and not about a run.
//!
//! Everything is value-blind in the way the verbs are: what goes into a
//! context is what the caller passes, so a caller must not pass a credential;
//! a refusal carries a reason and never the verdict's message.

use std::future::Future;

use agent_hooks::InterceptionPoint;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::authority::{Authority, Pinned};
use super::refusal::Refusal;
use super::session::HookSession;
use super::verbs::{unencodable, Verb};

/// A model's answer, as `response` in a `post_model_call` context (§4.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelResponse {
    /// The text, or `null` for a turn that only calls tools.
    pub content: Value,
    /// The tool calls the model proposed, each `{id, name, args}`.
    pub tool_calls: Vec<Value>,
    /// Why the model stopped, as the provider names it.
    pub finish_reason: String,
}

impl ModelResponse {
    /// §4.2's shape: `content` is a string, an object or `null`, and each
    /// proposed call is `{id: string, name: string, args: object}`.
    fn well_formed(&self) -> bool {
        matches!(
            self.content,
            Value::Null | Value::String(_) | Value::Object(_)
        ) && self.tool_calls.iter().all(|call| {
            call["id"].is_string() && call["name"].is_string() && call["args"].is_object()
        })
    }
}

/// §4.2's shape for `messages`: each is `{role: string, content: string | object}`.
fn well_formed_messages(messages: &[Value]) -> bool {
    messages.iter().all(|message| {
        message["role"].is_string()
            && matches!(message["content"], Value::String(_) | Value::Object(_))
    })
}

/// A tool named per call. Its arguments are a JSON object (§4.2's `args: {}`,
/// so a transform to anything else is refused rather than handed to the
/// tool); its result is JSON, `Ok(value)` or `Err(value)`, and a transform may
/// rewrite the value but not turn an error into a success (`is_error` is not
/// part of the target, §4.3).
struct NamedTool;

/// A tool the host does not know statically has no member it can call
/// authority: the model names it, and its arguments are whatever it takes.
/// The verbs' pinned credential, slot and origin have no counterpart here.
impl Authority for Map<String, Value> {
    fn pinned(&self) -> Pinned {
        Pinned::default()
    }
}

impl Verb for NamedTool {
    /// Never read: [`HookSession::tool_call`] names each call.
    const NAME: &'static str = "";
    type Args = Map<String, Value>;
    type Out = Result<Value, Value>;

    fn encode(out: &Self::Out) -> (Value, bool) {
        match out {
            Ok(value) => (value.clone(), false),
            Err(value) => (value.clone(), true),
        }
    }

    fn decode(out: Self::Out, value: Value) -> Option<Self::Out> {
        Some(out.map(|_| value.clone()).map_err(|_| value))
    }

    fn refused() -> Self::Out {
        Err(Value::Null)
    }
}

impl HookSession {
    /// Bracket one call to the tool `name` with JSON `args`: `pre_tool_call`,
    /// `invoke` with the effective arguments, `post_tool_call`, and the
    /// effective result. The same bracket the verbs use.
    ///
    /// `id` is the `tool_call.id` both emissions carry (§4.2) — the one the
    /// caller was given for the call, so a pair correlates with what proposed
    /// it. A verb's id is minted by the session; a proposed call's is not.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when a block at `pre_tool_call` means `invoke` never
    /// ran, or a block at `post_tool_call` means its result is discarded
    /// (§6, §6.1, §6.2), or when `args` is not a JSON object, which is no
    /// context to emit (§6.3) and is refused without one.
    pub async fn tool_call<F, Fut>(
        &self,
        id: &str,
        name: &str,
        args: Value,
        invoke: F,
    ) -> Result<Result<Value, Value>, Refusal>
    where
        F: FnOnce(Value) -> Fut + Send,
        Fut: Future<Output = Result<Value, Value>> + Send,
    {
        let Value::Object(args) = args else {
            return Err(unencodable(InterceptionPoint::PreToolCall));
        };
        self.bracket_named::<NamedTool, _, _>(id, name, args, |args| invoke(Value::Object(args)))
            .await
    }

    /// Emit `pre_model_call` for a request to `model_id` and hand back the
    /// messages it may send — transformed, if the verdict transformed them.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the request must not be sent (§6), including a
    /// transform that leaves something other than a list of §4.2 messages,
    /// and `messages` that are not §4.2 messages to begin with (§6.3, refused
    /// without an emission).
    pub async fn pre_model_call(
        &self,
        model_id: &str,
        messages: Vec<Value>,
    ) -> Result<Vec<Value>, Refusal> {
        if !well_formed_messages(&messages) {
            return Err(unencodable(InterceptionPoint::PreModelCall));
        }
        self.emit(
            InterceptionPoint::PreModelCall,
            |builder| builder.pre_model_call(model_id, messages),
            |target| match target {
                Value::Array(messages) if well_formed_messages(&messages) => Some(messages),
                _ => None,
            },
        )
        .await
    }

    /// Emit `post_model_call` for `response` and hand back what the run may
    /// act on — transformed, if the verdict transformed it.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the response must not be used (§6), including a
    /// transform that leaves something that is not a §4.2 response, a
    /// response that is not one to begin with (§6.3, refused without an
    /// emission), and a `post_model_call` with no proceeding `pre_model_call`
    /// still open to pair with (§3.1.4, refused without an emission).
    pub async fn post_model_call(
        &self,
        model_id: &str,
        response: ModelResponse,
    ) -> Result<ModelResponse, Refusal> {
        if !response.well_formed() {
            return Err(unencodable(InterceptionPoint::PostModelCall));
        }
        self.emit(
            InterceptionPoint::PostModelCall,
            |builder| {
                builder.post_model_call(
                    model_id,
                    response.content,
                    response.tool_calls,
                    &response.finish_reason,
                )
            },
            |target| {
                serde_json::from_value::<ModelResponse>(target)
                    .ok()
                    .filter(ModelResponse::well_formed)
            },
        )
        .await
    }
}
