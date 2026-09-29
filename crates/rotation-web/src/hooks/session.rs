//! One run's agent-hooks session: the emitter, the context builder, the
//! lifecycle phase and the records, behind one lock.
//!
//! Everything that makes an emission is serialized through [`HookSession`]'s
//! lock, and that is deliberate rather than convenient. The context builder
//! hands out `sequence` numbers, the emitter composes and records, and the
//! phase decides whether an interception point may be emitted at all; holding
//! the three together is what makes §12.2.3 ("assign `sequence` atomically")
//! and §3.1's ordering true *by construction* when two verbs run at once. The
//! guarded actions themselves never run under the lock — only their emissions
//! do — so concurrent verbs still overlap.
//!
//! The phase is the other half of the ordering. §6.1a says a denied
//! `agent_startup` means nothing else may be emitted, and §3.1 says
//! `agent_startup` precedes and `agent_shutdown` follows everything; a tool
//! verb called outside a turn is therefore refused **without an emission**,
//! because emitting it would be the violation.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use agent_hooks::{
    AgentContext, AgentContextBuilder, ApprovalResolver, CompositionConfig, EnforcementMode,
    HostError, IdentityProvider, InterceptionEmitter, InterceptionPoint, InterceptionRecord,
    Interceptor, Verdict,
};
use futures::lock::Mutex;
use serde_json::Value;

use super::labels::LabelLedger;
use super::refusal::{Refusal, ShutdownReason, OUT_OF_ORDER};

/// `agent.framework` on every context this crate emits.
pub const FRAMEWORK: &str = "opensesame-rotation-web";

/// Where each emitted record goes, as it is made.
///
/// Called once per emission, in `sequence` order, with the payload-free
/// §10.3 projection — never the context. This is how a run's observation log
/// or audit trail persists them.
pub type RecordSink = Arc<dyn Fn(&InterceptionRecord) + Send + Sync>;

/// How a run's hook session is configured. Host configuration (§7.1), never
/// something a driving agent can reach.
pub struct SessionConfig {
    /// `agent.id` — which `OpenSesame` runner this is.
    pub agent_id: String,
    /// `session.id` — the run's identifier, so records join the run's log.
    pub session_id: String,
    /// `enforce`, or `evaluate_only` for a shadow rollout (§8).
    pub mode: EnforcementMode,
    /// The composition profile and knobs (§7.2).
    pub composition: CompositionConfig,
    /// The identity provider (§10.1). `jcs-sha256` unless a caller says
    /// otherwise, because approvals bind to it (ADR 0150 §6).
    pub identity: IdentityProvider,
}

impl SessionConfig {
    /// Enforcing, `sequential/first_deny`, `jcs-sha256` — the SDK's defaults.
    #[must_use]
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            agent_id: FRAMEWORK.to_owned(),
            session_id: session_id.into(),
            mode: EnforcementMode::Enforce,
            composition: CompositionConfig::default(),
            identity: IdentityProvider::JcsSha256,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Nothing emitted yet.
    Fresh,
    /// Started, between turns: an `input` may arrive.
    Idle,
    /// Inside a turn: tool verbs and the `output` may be emitted.
    Turn,
    /// A startup or input deny: nothing but `agent_shutdown` may follow.
    Refused,
    /// `agent_shutdown` was emitted.
    Closed,
}

const fn admits(phase: Phase, point: InterceptionPoint) -> bool {
    match point {
        InterceptionPoint::AgentStartup => matches!(phase, Phase::Fresh),
        InterceptionPoint::Input => matches!(phase, Phase::Idle),
        InterceptionPoint::AgentShutdown => {
            matches!(phase, Phase::Idle | Phase::Turn | Phase::Refused)
        }
        // Tool verbs and the output belong to a turn. The model points are
        // never emitted by this host (it makes no model calls, §3.2).
        _ => matches!(phase, Phase::Turn),
    }
}

/// Where the phase goes after an emission at `point` proceeds or blocks.
const fn after(phase: Phase, point: InterceptionPoint, proceeded: bool) -> Phase {
    match (point, proceeded) {
        // A refused output still ends the turn: the response is withheld.
        (InterceptionPoint::AgentStartup, true) | (InterceptionPoint::Output, _) => Phase::Idle,
        (InterceptionPoint::Input, true) => Phase::Turn,
        (InterceptionPoint::AgentStartup | InterceptionPoint::Input, false) => Phase::Refused,
        _ => phase,
    }
}

struct State {
    builder: AgentContextBuilder,
    emitter: InterceptionEmitter,
    phase: Phase,
    labels: LabelLedger,
    records: Vec<InterceptionRecord>,
    last_refusal: Option<Refusal>,
}

/// One run's agent-hooks session.
///
/// Built once per run with the interceptors and the optional approval
/// resolver the caller injects — the gateway registers `OpenSesame`'s own
/// interceptor here — and shared by the hosted transport and the run driver.
pub struct HookSession {
    state: Mutex<State>,
    sink: Option<RecordSink>,
    calls: AtomicU64,
}

impl HookSession {
    /// A session over `interceptors`, in registration order, with `resolver`
    /// as the §9 approval seam.
    ///
    /// # Errors
    ///
    /// [`HostError::ContextInvalid`] when a custom identity provider's name
    /// breaks the §10.1 naming rules.
    pub fn new(
        config: SessionConfig,
        interceptors: Vec<Box<dyn Interceptor>>,
        resolver: Option<Box<dyn ApprovalResolver>>,
    ) -> Result<Self, HostError> {
        let mut emitter = InterceptionEmitter::new(config.mode, resolver);
        emitter.set_composition(config.composition);
        emitter
            .set_identity_provider(config.identity)
            .map_err(|(error, _)| error)?;
        let labels = LabelLedger::default();
        for interceptor in interceptors {
            emitter.register(labels.wrap(interceptor));
        }
        Ok(Self {
            state: Mutex::new(State {
                builder: AgentContextBuilder::new(&config.agent_id, FRAMEWORK, &config.session_id),
                emitter,
                phase: Phase::Fresh,
                labels,
                records: Vec::new(),
                last_refusal: None,
            }),
            sink: None,
            calls: AtomicU64::new(0),
        })
    }

    /// Deliver every record to `sink` as it is made.
    #[must_use]
    pub fn with_record_sink(mut self, sink: RecordSink) -> Self {
        self.sink = Some(sink);
        self
    }

    /// Register the §9/§14 approval redactor: what an approver is shown, and
    /// what `context_identity` is computed over.
    #[must_use]
    pub fn with_approval_redactor(
        mut self,
        redactor: impl Fn(&AgentContext) -> AgentContext + Send + Sync + 'static,
    ) -> Self {
        self.state.get_mut().emitter.set_approval_redactor(redactor);
        self
    }

    /// Replace the context timestamp source (deterministic tests).
    #[must_use]
    pub fn with_timestamps(mut self, now: impl Fn() -> String + Send + Sync + 'static) -> Self {
        let state = self.state.get_mut();
        let builder = std::mem::replace(&mut state.builder, AgentContextBuilder::new("", "", ""));
        state.builder = builder.with_timestamp_provider(now);
        self
    }

    /// Every record emitted so far, in `sequence` order.
    pub async fn records(&self) -> Vec<InterceptionRecord> {
        self.state.lock().await.records.clone()
    }

    /// The most recent refusal, so a caller holding only a `StepError` can
    /// learn the verdict's reason. Never content: a reason or a fixed marker.
    pub async fn last_refusal(&self) -> Option<Refusal> {
        self.state.lock().await.last_refusal.clone()
    }

    /// Emit `agent_startup` with the verbs this session's transport exposes.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] when the combined verdict blocks the session (§6.1a).
    pub async fn startup(&self, tools: &[&str]) -> Result<(), Refusal> {
        let tools = tools.iter().map(|&name| name.to_owned()).collect();
        self.emit(
            InterceptionPoint::AgentStartup,
            |builder| builder.agent_startup(tools),
            |_| Some(()),
        )
        .await
    }

    /// Emit `agent_shutdown` and close the session. Its verdict is recorded
    /// and imposes nothing (§6.1a). A session that never started emits
    /// nothing, because a shutdown with no startup breaks §3.1.
    pub async fn shutdown(&self, reason: ShutdownReason) -> Option<InterceptionRecord> {
        let mut state = self.state.lock().await;
        if !admits(state.phase, InterceptionPoint::AgentShutdown) {
            return None;
        }
        let mut context = state.builder.agent_shutdown(reason.as_str());
        let record = state.emitter.emit_unchecked(&mut context).await;
        state.emitter.take_records();
        // Nothing follows a shutdown, so there is nothing to resurface to.
        state.labels.settle(false, &record.verdict);
        state.phase = Phase::Closed;
        self.deliver(&mut state, record.clone());
        Some(record)
    }

    /// A fresh `tool_call.id`. Payload-free: a counter, never an argument.
    pub(crate) fn next_call_id(&self) -> String {
        format!("call-{}", self.calls.fetch_add(1, Ordering::Relaxed))
    }

    /// Emit one context and hand back the effective target, decoded.
    ///
    /// `decode` turns the post-composition target back into what the guarded
    /// action consumes. When a transform produced something it cannot take —
    /// a string where the verb takes a selector object, an image that is not
    /// in the context — the transform could not be applied, and the host
    /// substitutes `host_error:transform_invalid` (§5.2, §11) in the record
    /// rather than ignoring the verdict or delivering a record that says the
    /// transform happened.
    pub(crate) async fn emit<T>(
        &self,
        point: InterceptionPoint,
        build: impl FnOnce(&mut AgentContextBuilder) -> AgentContext,
        decode: impl FnOnce(Value) -> Option<T>,
    ) -> Result<T, Refusal> {
        let mut state = self.state.lock().await;
        if !admits(state.phase, point) {
            let refusal = Refusal::new(point, Some(OUT_OF_ORDER.to_owned()));
            state.last_refusal = Some(refusal.clone());
            return Err(refusal);
        }
        let mut context = build(&mut state.builder);
        let mut record = state.emitter.emit_unchecked(&mut context).await;
        // The session keeps its own (possibly amended) copy; the emitter's
        // buffer would otherwise grow for the life of the run.
        state.emitter.take_records();
        let outcome = if record.proceeds() {
            let target = context.get("target").cloned().unwrap_or(Value::Null);
            decode(target).ok_or_else(|| {
                // §10.3: `decided_by` is null for a transform-application
                // failure, and `enforced_identity` equals `input_identity`
                // when no transform was applied — the transformed context
                // the SDK hashed is one the host refused to act on.
                record.verdict = Verdict::host_error(HostError::TransformInvalid, None);
                record.decided_by = None;
                record.enforced_identity.clone_from(&record.input_identity);
                Refusal::of(&record)
            })
        } else {
            Err(Refusal::of(&record))
        };
        state.phase = after(state.phase, point, outcome.is_ok());
        // §5.4: labels persist only for an emission the host acted on, and
        // ride every later context (the `labels` module says why every one).
        if let Some(extensions) = state.labels.settle(outcome.is_ok(), &record.verdict) {
            state.builder.with_optional("extensions", extensions);
        }
        if let Err(refusal) = &outcome {
            state.last_refusal = Some(refusal.clone());
        }
        self.deliver(&mut state, record);
        outcome
    }

    fn deliver(&self, state: &mut State, record: InterceptionRecord) {
        if let Some(sink) = &self.sink {
            // Audit delivery must not take the run down with it; the SDK's
            // own sink contract makes the same choice.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&record)));
        }
        state.records.push(record);
    }
}
