//! Each tool verb as `tool_call.args` and `tool_result.value`, and the one
//! bracket every verb goes through.
//!
//! A verb is a [`Verb`]: typed arguments that serialize to the `args` object
//! and deserialize back, and a result codec. The round trip is what makes a
//! `transform` verdict *applied* rather than merely recorded (§4.3): the
//! transformed `args` are decoded into the typed call and the inner transport
//! is called with them, and a transformed result is decoded into what the
//! caller receives. Where the round trip cannot hold, the transform is refused
//! as `host_error:transform_invalid` — it is never ignored.
//!
//! Every argument struct is `deny_unknown_fields`, so a transform that adds a
//! member the verb does not take is refused rather than silently dropped.
//! Nothing here can carry a credential value: the arguments are URLs,
//! selectors and *references*, and the results are the outcomes the tool
//! boundary already returns (ADR 0076 §1).

use std::future::Future;

use opensesame_ceremony::{CaptureDigest, Slot};
use opensesame_session_observe::LayoutEpoch;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use agent_hooks::{HostError, InterceptionPoint};

use super::args::{
    CaptureDownloadArgs, CaptureFieldArgs, MaskArgs, NoArgs, PlacedRefArgs, RefArgs, SelectorArgs,
    UrlArgs,
};
use super::authority::Authority;
use super::refusal::Refusal;
use super::session::HookSession;
use crate::ceremony::CaptureError;
use crate::tools::{AdmittedFrame, RedactedDom, StepError};

/// A tool verb, as the hook session sees it.
pub(crate) trait Verb {
    /// `tool_call.name`.
    const NAME: &'static str;
    /// `tool_call.args`, typed. [`Authority`] is required so that a verb
    /// cannot exist without saying which of its arguments an interceptor may
    /// not rewrite (`hooks::authority`).
    type Args: Serialize + DeserializeOwned + Authority + Send;
    /// What the inner transport returns.
    type Out: Send;
    /// `tool_result.value` and `tool_result.is_error`.
    fn encode(out: &Self::Out) -> (Value, bool);
    /// The result the caller receives when the effective value is `value`.
    /// `None` when it cannot be expressed as `Out`.
    fn decode(out: Self::Out, value: Value) -> Option<Self::Out>;
    /// What a refused call returns: an error, never a plausible answer.
    fn refused() -> Self::Out;
}

/// A redacted DOM read, as `tool_result.value`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DomValue {
    text: String,
    epoch: u64,
}

fn encode_serde<T: Serialize, E: Serialize>(out: &Result<T, E>) -> (Value, bool) {
    let (value, is_error) = match out {
        Ok(value) => (serde_json::to_value(value), false),
        Err(error) => (serde_json::to_value(error), true),
    };
    // These are plain enums and structs; a failure is unreachable, and null
    // is what the decode side refuses, so it would fail closed regardless.
    (value.unwrap_or(Value::Null), is_error)
}

/// An error stays an error: `is_error` is not part of the target (§4.3), so a
/// transform may rewrite which error, never turn one into a success.
fn decode_serde<T: DeserializeOwned, E: DeserializeOwned>(
    out: &Result<T, E>,
    value: Value,
) -> Option<Result<T, E>> {
    match out {
        Ok(_) => serde_json::from_value(value).ok().map(Ok),
        Err(_) => serde_json::from_value(value).ok().map(Err),
    }
}

macro_rules! serde_verb {
    ($verb:ident, $name:literal, $args:ty, $ok:ty, $err:ty, $refused:expr) => {
        pub(crate) struct $verb;
        impl Verb for $verb {
            const NAME: &'static str = $name;
            type Args = $args;
            type Out = Result<$ok, $err>;
            fn encode(out: &Self::Out) -> (Value, bool) {
                encode_serde(out)
            }
            fn decode(out: Self::Out, value: Value) -> Option<Self::Out> {
                decode_serde(&out, value)
            }
            fn refused() -> Self::Out {
                Err($refused)
            }
        }
    };
}

serde_verb!(
    Navigate,
    "navigate",
    UrlArgs,
    (),
    StepError,
    StepError::Refused
);
serde_verb!(
    WaitFor,
    "wait_for",
    SelectorArgs,
    (),
    StepError,
    StepError::Refused
);
serde_verb!(
    Submit,
    "submit",
    SelectorArgs,
    (),
    StepError,
    StepError::Refused
);
serde_verb!(
    FillCredential,
    "fill_credential",
    PlacedRefArgs,
    crate::tools::Filled,
    StepError,
    StepError::Refused
);
serde_verb!(
    AssertPresent,
    "assert_present",
    PlacedRefArgs,
    crate::tools::Presence,
    StepError,
    StepError::Refused
);
serde_verb!(
    VerifyLogin,
    "verify_login",
    RefArgs,
    crate::tools::Verified,
    StepError,
    StepError::Refused
);
serde_verb!(
    CaptureCredential,
    "capture_credential",
    CaptureFieldArgs,
    CaptureDigest,
    CaptureError,
    CaptureError::Step(StepError::Refused)
);
serde_verb!(
    CaptureDownload,
    "capture_download",
    CaptureDownloadArgs,
    CaptureDigest,
    CaptureError,
    CaptureError::Step(StepError::Refused)
);

/// `read_dom_redacted`: the text is already stripped at capture, and a
/// transform of it (a secret guard's redaction) is what the caller reads.
pub(crate) struct ReadDom;
impl Verb for ReadDom {
    const NAME: &'static str = "read_dom_redacted";
    type Args = NoArgs;
    type Out = Result<RedactedDom, StepError>;
    fn encode(out: &Self::Out) -> (Value, bool) {
        let view = out.as_ref().map(|dom| DomValue {
            text: dom.text().to_owned(),
            epoch: RedactedDom::epoch(dom).0,
        });
        encode_serde(&view)
    }
    fn decode(out: Self::Out, value: Value) -> Option<Self::Out> {
        match out {
            Ok(_) => serde_json::from_value::<DomValue>(value)
                .ok()
                .map(|dom| Ok(RedactedDom::from_stripped(dom.text, LayoutEpoch(dom.epoch)))),
            Err(_) => serde_json::from_value(value).ok().map(Err),
        }
    }
    fn refused() -> Self::Out {
        Err(StepError::Refused)
    }
}

/// `screenshot_redacted`: the image is not in the context — only its epoch
/// and size are — so the one transform that can be applied is `null`, which
/// drops the frame. Anything else would be an image nobody admitted.
pub(crate) struct Screenshot;
impl Screenshot {
    fn describe(frame: &AdmittedFrame) -> Value {
        json!({ "epoch": frame.epoch().0, "byte_length": frame.bytes().len() })
    }
}
impl Verb for Screenshot {
    const NAME: &'static str = "screenshot_redacted";
    type Args = MaskArgs;
    type Out = Result<Option<AdmittedFrame>, StepError>;
    fn encode(out: &Self::Out) -> (Value, bool) {
        match out {
            Ok(Some(frame)) => (Self::describe(frame), false),
            Ok(None) => (Value::Null, false),
            Err(error) => encode_serde::<(), _>(&Err(*error)),
        }
    }
    fn decode(out: Self::Out, value: Value) -> Option<Self::Out> {
        match out {
            Ok(_) if value.is_null() => Some(Ok(None)),
            Ok(Some(frame)) if value == Self::describe(&frame) => Some(Ok(Some(frame))),
            Ok(_) => None,
            Err(error) => decode_serde::<(), _>(&Err(error), value).map(|out| out.map(|()| None)),
        }
    }
    fn refused() -> Self::Out {
        Err(StepError::Refused)
    }
}

/// `outstanding`: infallible by signature, so a refusal cannot be an error.
/// It answers every slot instead — a denied ledger read must never read as a
/// finished ceremony, which is the direction an empty list would fail in —
/// and the hosted transport remembers the refusal, so a hosted capture run
/// fails rather than reporting it (`run_capture_steps_hooked`).
pub(crate) struct Outstanding;
impl Verb for Outstanding {
    const NAME: &'static str = "outstanding";
    type Args = NoArgs;
    type Out = Vec<Slot>;
    fn encode(out: &Self::Out) -> (Value, bool) {
        (serde_json::to_value(out).unwrap_or(Value::Null), false)
    }
    fn decode(_out: Self::Out, value: Value) -> Option<Self::Out> {
        serde_json::from_value(value).ok()
    }
    fn refused() -> Self::Out {
        Slot::ALL.to_vec()
    }
}

impl HookSession {
    /// Bracket one verb: `pre_tool_call`, the inner call with the effective
    /// arguments, `post_tool_call`, and the effective result.
    ///
    /// A block at `pre_tool_call` means `invoke` is never called and no
    /// `post_tool_call` is emitted (§6, §6.2). A block at `post_tool_call`
    /// discards the result as if it had errored (§6.1).
    pub(crate) async fn tool<V, F, Fut>(&self, args: V::Args, invoke: F) -> V::Out
    where
        V: Verb,
        F: FnOnce(V::Args) -> Fut + Send,
        Fut: Future<Output = V::Out> + Send,
    {
        self.bracket::<V, F, Fut>(args, invoke)
            .await
            .unwrap_or_else(V::refused)
    }

    /// [`Self::tool`], saying whether the call was refused (`None`) — for a
    /// verb whose refused answer is not an error ([`Outstanding`]).
    pub(crate) async fn bracket<V, F, Fut>(&self, args: V::Args, invoke: F) -> Option<V::Out>
    where
        V: Verb,
        F: FnOnce(V::Args) -> Fut + Send,
        Fut: Future<Output = V::Out> + Send,
    {
        let id = self.next_call_id();
        self.bracket_named::<V, F, Fut>(&id, V::NAME, args, invoke)
            .await
            .ok()
    }

    /// The one bracket, under `id` and `name`: every verb goes through it with
    /// a minted id and its own [`Verb::NAME`], and a tool the host does not
    /// know statically ([`HookSession::tool_call`]) goes through it with the
    /// id and name a model gave it. The refusal says where and why (a reason,
    /// never content).
    ///
    /// A transform is applied only when it leaves the run's authority as the
    /// executor proposed it: the credential, the slot and the origin a
    /// navigation reaches are not an interceptor's to rewrite. Anything else
    /// is `transform_invalid`, exactly as for a transform the verb cannot
    /// decode.
    pub(crate) async fn bracket_named<V, F, Fut>(
        &self,
        id: &str,
        name: &str,
        args: V::Args,
        invoke: F,
    ) -> Result<V::Out, Refusal>
    where
        V: Verb,
        F: FnOnce(V::Args) -> Fut + Send,
        Fut: Future<Output = V::Out> + Send,
    {
        let proposed =
            serde_json::to_value(&args).map_err(|_| unencodable(InterceptionPoint::PreToolCall))?;
        let pinned = args.pinned();
        let args = self
            .emit(
                InterceptionPoint::PreToolCall,
                |builder| builder.pre_tool_call(id, name, proposed),
                |target| {
                    serde_json::from_value::<V::Args>(target)
                        .ok()
                        .filter(|effective| effective.pinned() == pinned)
                },
            )
            .await?;
        // §4.2: `tool_call.args` at `post_tool_call` is what was passed.
        let passed = serde_json::to_value(&args)
            .map_err(|_| unencodable(InterceptionPoint::PostToolCall))?;
        let out = invoke(args).await;
        let (value, is_error) = V::encode(&out);
        self.emit(
            InterceptionPoint::PostToolCall,
            |builder| builder.post_tool_call(id, name, passed, value, is_error),
            move |target| V::decode(out, target),
        )
        .await
    }
}

/// Arguments that cannot be put in a context are refused, not guessed at.
pub(super) fn unencodable(point: InterceptionPoint) -> Refusal {
    Refusal::new(point, Some(HostError::ContextInvalid.to_string()))
}
